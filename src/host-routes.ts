import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { TaskBoardHostService } from './host-service.ts'
import { isValidArchiveBatchId } from './core/archive-id.ts'
import { writeJson } from './http.ts'
import { isLoopbackAddress, isLoopbackRequest } from './loopback.ts'
import { parseActionEnvelope, TASK_BOARD_API_PREFIX } from './protocol.ts'

const ACTION_LIMIT = 64 * 1024
const IMPORT_LIMIT = 2 * 1024 * 1024
const HEARTBEAT_MS = 15_000

/** Archive read routes (方案 §3 D-4). */
const ARCHIVE_PATH = `${TASK_BOARD_API_PREFIX}/archive`
/** Hard cap on one archive page, cards and batches alike (方案 §5 J8). */
const ARCHIVE_PAGE_MAX = 100
const ARCHIVE_PAGE_DEFAULT = 100

/** Header replaced by an authenticated same-host reverse proxy. */
export const TASK_BOARD_PROXY_TOKEN_HEADER = 'x-dsh-task-board-proxy-token'

/** Optional authenticated reverse-proxy access layered over the loopback default. */
export interface TaskBoardRouteAccess {
  trustedProxyHosts?: readonly string[]
  proxyToken?: string
}

interface ResolvedRouteAccess {
  trustedProxyHosts: ReadonlySet<string>
  proxyToken?: string
}

function parseAuthority(authority: string): { canonical: string; url: URL } | undefined {
  if (authority.trim() !== authority) return undefined
  const match = authority.startsWith('[')
    ? /^\[[^\]]+\](?::([0-9]+))?$/.exec(authority)
    : /^[^:@/?#\s]+(?::([0-9]+))?$/.exec(authority)
  if (match === null) return undefined
  try {
    const url = new URL(`http://${authority}`)
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
    const rawPort = match[1]
    if (rawPort !== undefined && (String(Number(rawPort)) !== rawPort || Number(rawPort) > 65_535)) return undefined
    return { canonical: url.hostname.toLowerCase() + (rawPort === undefined ? '' : `:${rawPort}`), url }
  } catch {
    return undefined
  }
}

function resolveAccess(access: TaskBoardRouteAccess): ResolvedRouteAccess {
  const trustedProxyHosts = new Set<string>()
  for (const authority of access.trustedProxyHosts ?? []) {
    const parsed = parseAuthority(authority)
    if (parsed === undefined || parsed.canonical !== authority.toLowerCase()) {
      throw new Error(`task-board: trustedProxyHosts entry ${JSON.stringify(authority)} is not a canonical host[:port] authority`)
    }
    trustedProxyHosts.add(parsed.canonical)
  }
  if (trustedProxyHosts.size > 0 && (access.proxyToken === undefined || access.proxyToken === '')) {
    throw new Error('task-board: authenticated proxy hosts require a non-empty proxy token')
  }
  return { trustedProxyHosts, ...(access.proxyToken === undefined ? {} : { proxyToken: access.proxyToken }) }
}

/**
 * Browser-signal tripwire, NOT an authority check: a bare curl sends neither
 * header and is refused, but a curl with a forged Origin passes this too.
 * The real boundary is the loopback socket + Host + origin-equality checks
 * in isTrustedTaskBoardRequest below; do not rely on this marker alone.
 */
function browserSameOriginMarker(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return site === 'same-origin' || typeof req.headers.origin === 'string'
}

function sameAuthority(req: IncomingMessage, host: URL): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return req.headers['sec-fetch-site'] === 'same-origin'
  try {
    return new URL(origin).host === host.host
  } catch {
    return false
  }
}

function matchesToken(candidate: string | string[] | undefined, expected: string | undefined): boolean {
  if (typeof candidate !== 'string' || expected === undefined || candidate === '' || expected === '') return false
  const actual = Buffer.from(candidate)
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

/**
 * Task-board route fence. Direct desktop access uses the repository-wide
 * loopback socket + Host guard and additionally requires a browser same-origin
 * marker: a bare local curl without any browser signal cannot exercise the
 * agent control plane (a forged Origin does pass the marker — it is a
 * tripwire, the socket/Host/origin-equality checks carry the authority).
 * Authenticated proxies must be explicitly allowlisted and replace the
 * internal token header after their own authentication step.
 */
export function isTrustedTaskBoardRequest(req: IncomingMessage, access: ResolvedRouteAccess): boolean {
  if (!browserSameOriginMarker(req)) return false
  if (isLoopbackRequest(req)) return true
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  const parsed = parseAuthority(host)
  if (parsed === undefined || parsed.canonical !== host.toLowerCase()) return false
  if (!access.trustedProxyHosts.has(parsed.canonical) || !sameAuthority(req, parsed.url)) return false
  return matchesToken(req.headers[TASK_BOARD_PROXY_TOKEN_HEADER], access.proxyToken)
}

async function readBody(req: IncomingMessage): Promise<{ raw: string; value: unknown }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > IMPORT_LIMIT) throw new Error('body-too-large')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return { raw, value: JSON.parse(raw) }
}

/**
 * Board-scope selector for GET /state.
 *
 * Why a header rather than `?scope=`: the route is registered as an exact
 * path, so any query suffix risks missing the route table entirely, while a
 * header rides along on every request without touching the path.
 *
 * Default stays `'all'` (byte-for-byte the previous payload) so no existing
 * reader changes behaviour; pollers opt in with `x-dsh-board-scope: live`.
 */
function readScopeHeader(req: IncomingMessage): 'all' | 'live' {
  const raw = req.headers['x-dsh-board-scope']
  return (Array.isArray(raw) ? raw[0] : raw) === 'live' ? 'live' : 'all'
}

/** Parse `?limit&offset` for the archive routes, clamping to the 100-card page cap. */
function readPaging(url: URL): { limit: number; offset: number } {
  const read = (name: string, fallback: number, min: number, max: number): number => {
    const raw = url.searchParams.get(name)
    if (raw === null || raw.trim() === '') return fallback
    const value = Number(raw)
    if (!Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(value)))
  }
  return {
    limit: read('limit', ARCHIVE_PAGE_DEFAULT, 1, ARCHIVE_PAGE_MAX),
    offset: read('offset', 0, 0, Number.MAX_SAFE_INTEGER),
  }
}

/** Request pathname, with the query string stripped. */
function requestUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://localhost')
  } catch {
    return new URL('/', 'http://localhost')
  }
}

/** ETag for a ledger revision; quoted so it is a valid entity tag. */
function revisionTag(revision: number): string {
  return `"${revision}"`
}

/**
 * `If-None-Match` / `?since=` short circuit (方案 §3 D-9, optional).
 *
 * Only a caller that opts in can ever receive a 304, so the default reader
 * behaviour (full payload) is untouched. The comparison runs BEFORE the
 * snapshot is built: the point of D-9 is to skip serializing megabytes of
 * cards, not to skip sending them.
 */
function matchesRevision(req: IncomingMessage, url: URL, revision: number): boolean {
  const raw = req.headers['if-none-match']
  const header = Array.isArray(raw) ? raw[0] : raw
  if (typeof header === 'string' && header.split(',').some(part => {
    const token = part.trim()
    return token === revisionTag(revision) || token === String(revision) || token === `W/${revisionTag(revision)}`
  })) {
    return true
  }
  const since = url.searchParams.get('since')
  return since !== null && since.trim() === String(revision)
}

export function makeTaskBoardRoutes(service: TaskBoardHostService, access: TaskBoardRouteAccess = {}): WebRoute[] {
  const resolvedAccess = resolveAccess(access)
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (isTrustedTaskBoardRequest(req, resolvedAccess)) return true
    writeJson(res, 403, { ok: false, error: 'forbidden' }, { 'cache-control': 'no-store' })
    return false
  }
  const state: WebRoute = {
    kind: 'exact',
    path: `${TASK_BOARD_API_PREFIX}/state`,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, { 'cache-control': 'no-store' })
      if (!guard(req, res)) return
      const revision = service.revision()
      const tag = revisionTag(revision)
      if (matchesRevision(req, requestUrl(req), revision)) {
        res.writeHead(304, { etag: tag, 'cache-control': 'no-store' })
        res.end()
        return
      }
      writeJson(res, 200, service.snapshot(readScopeHeader(req)), { 'cache-control': 'no-store', etag: tag })
    },
  }
  /**
   * `GET /archive` — batch list from `archive-index.json` (方案 §3 D-4).
   *
   * Carries each batch's `count` plus a board-wide `totals`, so a reconciliation
   * reader can prove "sum of batch counts == index count" without pulling any
   * cards (方案 §5 J4 / J8). `limit` caps batches per page, same 100 ceiling as
   * the card page.
   */
  const archiveIndex: WebRoute = {
    kind: 'exact',
    path: ARCHIVE_PATH,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, { 'cache-control': 'no-store' })
      if (!guard(req, res)) return
      const page = readPaging(requestUrl(req))
      const index = service.archiveIndex()
      const batches = index.batches.slice(page.offset, page.offset + page.limit)
      writeJson(res, 200, {
        schemaVersion: 1,
        revision: index.revision,
        batches,
        totals: { batches: index.batches.length, cards: index.cardCount },
        total: index.batches.length,
        limit: page.limit,
        offset: page.offset,
        hasMore: page.offset + batches.length < index.batches.length,
      }, { 'cache-control': 'no-store' })
    },
  }
  /**
   * `GET /archive/<batchId>` — the cards of one batch, paged (方案 §3 D-4).
   *
   * `total` comes from the batch's OWN manifest/cards, never from the query, so
   * a client can prove its walk was complete (方案 §5 J8: "name the whole batch
   * once, dedup == count").
   */
  const archiveBatch: WebRoute = {
    kind: 'prefix',
    path: ARCHIVE_PATH,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, { 'cache-control': 'no-store' })
      if (!guard(req, res)) return
      const url = requestUrl(req)
      const rest = url.pathname.slice(ARCHIVE_PATH.length).replace(/^\/+/, '')
      if (rest === '' || rest.includes('/')) {
        return writeJson(res, 404, { ok: false, error: 'not-found' }, { 'cache-control': 'no-store' })
      }
      let batchId: string
      try {
        batchId = decodeURIComponent(rest)
      } catch {
        return writeJson(res, 400, { ok: false, error: 'invalid-batch-id' }, { 'cache-control': 'no-store' })
      }
      if (!isValidArchiveBatchId(batchId)) {
        return writeJson(res, 400, { ok: false, error: 'invalid-batch-id' }, { 'cache-control': 'no-store' })
      }
      const page = readPaging(url)
      const found = service.archiveBatch(batchId, page)
      if (found === undefined) {
        return writeJson(res, 404, { ok: false, error: 'archive batch not found' }, { 'cache-control': 'no-store' })
      }
      writeJson(res, 200, {
        schemaVersion: 1,
        batchId,
        batch: found.entry,
        cards: found.cards,
        total: found.total,
        limit: page.limit,
        offset: page.offset,
        hasMore: page.offset + found.cards.length < found.total,
      }, { 'cache-control': 'no-store' })
    },
  }
  const action: WebRoute = {
    kind: 'exact',
    path: `${TASK_BOARD_API_PREFIX}/action`,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, { 'cache-control': 'no-store' })
      if (!guard(req, res)) return
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return writeJson(res, 415, { ok: false, error: 'json-required' }, { 'cache-control': 'no-store' })
      }
      try {
        const body = await readBody(req)
        const parsed = parseActionEnvelope(body.value)
        if (parsed === undefined) return writeJson(res, 400, { ok: false, error: 'invalid-action' }, { 'cache-control': 'no-store' })
        if (parsed.action.kind !== 'import' && Buffer.byteLength(body.raw) > ACTION_LIMIT) {
          return writeJson(res, 413, { ok: false, error: 'body-too-large' }, { 'cache-control': 'no-store' })
        }
        writeJson(res, 200, service.apply(parsed.requestId, parsed.action, readScopeHeader(req)), { 'cache-control': 'no-store' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeJson(res, message === 'body-too-large' ? 413 : 400, { ok: false, error: message }, { 'cache-control': 'no-store' })
      }
    },
  }
  const events: WebRoute = {
    kind: 'exact',
    path: `${TASK_BOARD_API_PREFIX}/events`,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end()
        return
      }
      if (!guard(req, res)) return
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const push = (): void => {
        const payload = service.eventPayload()
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
      const unsubscribe = service.subscribe(push)
      const heartbeat = setInterval(() => { res.write(': ping\n\n') }, HEARTBEAT_MS)
      const close = (): void => {
        clearInterval(heartbeat)
        unsubscribe()
      }
      req.once('close', close)
      res.once('close', close)
      push()
    },
  }
  return [state, archiveIndex, archiveBatch, action, events]
}
