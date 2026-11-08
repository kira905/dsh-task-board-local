/**
 * Physical archive store for the task board ledger.
 *
 * Design source: `docs\看板瘦身与归档物理化-方案-20260924.md` §3 D-1 (layout),
 * §3 D-2 (write order), §3 D-3 (restore), §6 表 4 (half-finished states and
 * idempotency). Card [看板瘦身·K1] implements this module; the ledger wires it
 * into the `archive` / `archive-many` / `archive-compact` / `restore` /
 * `restore-many` actions.
 *
 * Layout (board directory = `$DSH_HOME/task-board`):
 *
 *   archive/<batchId>/cards.json     the cards moved out of the main ledger
 *   archive/<batchId>/manifest.json  { batchId, at, count, ids[], fromRevision, tool, host }
 *   archive-index.json               { schemaVersion, batches: [...] } — a cache
 *
 * Write order is FIXED by D-2 ("place it in the new home first, leave the old
 * home second"): cards.json -> manifest.json -> archive-index.json -> the
 * caller commits the main ledger. A crash in between leaves the main ledger
 * untouched and one orphan batch behind, which {@link planArchiveCleanup}
 * reports and {@link applyArchiveCleanup} removes.
 *
 * Authority (方案 §6 表 1): the manifest is the authority and the index is a
 * rebuildable cache — {@link readArchiveIndex} re-derives it from the manifests
 * whenever the two disagree.
 *
 * The module owns no ledger state: every function takes the board directory and
 * works on plain files, so a crash drill can drive it in its own process with a
 * {@link ArchiveStageHook}.
 */
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isValidArchiveBatchId } from './core/archive-id.ts'
import type { TaskRecord } from './core/tasks.ts'
// 2026-11-09 卡「账本写重试」：tmp → rename 统一走带退避重试的唯一口（EPERM/EACCES/EBUSY）。
import { isTmpPreserved, renameWithRetry } from './fs-atomic.ts'

// ── R-065「删除 / 搬移三件套」· 锁 batchD3 ──────────────────────────────────
// 判据全在生态共享闸（`production-guard.mjs`）里，本模块不复制任何判据。
// ⚠️ 该共享件**不随本包分发**：这里按 `DSH_PRODUCTION_GUARD`（可选，绝对路径或 file URL）
//   与包内相对位置两路探测；两路都拿不到 ⇒ 一律按"拒动"处理（fail-closed）：
//   宁可这次写失败可见，也不退回"没闸照删"。
const GUARD_CANDIDATES: readonly string[] = [
  process.env.DSH_PRODUCTION_GUARD ?? '',
  new URL('../lib/production-guard.mjs', import.meta.url).href,
].filter((s): s is string => s !== '')
interface GateResult {
  ok: boolean
  dryRun?: boolean
  code?: string | null
  exitCode?: number
  reason?: string
}
type GateFn = (o: Record<string, unknown>) => GateResult
const guardMod: { gateDestructive?: GateFn } | null = await (async () => {
  for (const spec of GUARD_CANDIDATES) {
    try {
      const mod = (await import(/* @vite-ignore */ spec)) as { gateDestructive?: GateFn }
      if (typeof mod.gateDestructive === 'function') return mod
    } catch { /* next candidate */ }
  }
  return null
})()
function gateDestructive(o: Record<string, unknown>): GateResult {
  if (!guardMod || typeof guardMod.gateDestructive !== 'function') {
    return {
      ok: false, dryRun: false, code: 'guard-unavailable', exitCode: 3,
      reason: 'R-065 共享闸不可用（未设 DSH_PRODUCTION_GUARD，包内也没有随附副本）⇒ 拒动（fail-closed）',
    }
  }
  return guardMod.gateDestructive(o)
}
function firstLine(s: unknown): string {
  return String(s ?? '').split('\n')[0]
}

/** Schema version of `archive-index.json` (方案 §3 状态文件清单). */
export const ARCHIVE_SCHEMA_VERSION = 1

/** Index file name under the board directory. */
export const ARCHIVE_INDEX_FILE = 'archive-index.json'

/** Directory name under the board directory. */
export const ARCHIVE_DIR_NAME = 'archive'

/**
 * Fixed write steps of D-2, exposed so a crash drill can stop the writer
 * between them. Production callers never pass a hook.
 */
export type ArchiveStage = 'cards-written' | 'manifest-written' | 'index-written'
export type ArchiveStageHook = (stage: ArchiveStage) => void

/** Batch metadata written next to the cards (方案 §3 D-1). */
export interface ArchiveBatchManifest {
  batchId: string
  at: number
  count: number
  ids: string[]
  fromRevision: number
  tool: string
  host: string
  /**
   * Set once every card of the batch has been restored (方案 §3 D-3). The
   * files themselves are never deleted — the marker is what tells a reader the
   * batch is empty on purpose.
   */
  restoredAt?: number
}

/** One row of `archive-index.json`; `ids[]` is the by-card lookup entry (方案 §3 D-1). */
export interface ArchiveBatchIndexEntry {
  batchId: string
  at: number
  count: number
  bytes: number
  path: string
  ids: string[]
  restoredAt?: number
}

export interface ArchiveIndexDocument {
  schemaVersion: number
  batches: ArchiveBatchIndexEntry[]
}

/** One batch on disk, with its manifest read back and validated. */
export interface ArchiveBatchRecord {
  manifest: ArchiveBatchManifest
  dir: string
  bytes: number
}

export interface WriteArchiveBatchInput {
  batchId: string
  at: number
  tasks: readonly TaskRecord[]
  fromRevision: number
  tool: string
  host: string
  onStage?: ArchiveStageHook
}

export function archiveRoot(boardDir: string): string {
  return join(boardDir, ARCHIVE_DIR_NAME)
}

export function archiveIndexFile(boardDir: string): string {
  return join(boardDir, ARCHIVE_INDEX_FILE)
}

/** Absolute directory of one batch; throws on a batch id that could escape the root. */
export function batchDirOf(boardDir: string, batchId: string): string {
  if (!isValidArchiveBatchId(batchId)) throw new Error(`invalid archive batch id: ${String(batchId)}`)
  return join(archiveRoot(boardDir), batchId)
}

type JsonRead =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'missing' | 'unreadable' | 'malformed' }

/**
 * Read + parse JSON without swallowing the reason: "the file is not there yet"
 * and "the file is there but unreadable" lead to different repair paths, and a
 * silent `undefined` for both would hide a corrupted batch.
 */
function readJson(file: string): JsonRead {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' }
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

function readJsonValue(file: string): unknown {
  const result = readJson(file)
  return result.ok ? result.value : undefined
}

/**
 * Atomic JSON write: `tmp` + fsync + rename, plus a best-effort directory
 * fsync (Windows rejects fsync on a directory handle — rename stays atomic).
 * R-065 (lock batchD3): the tmp→dest rename is a **move** ⇒ it goes through the
 * shared gate first (whitelist = the destination's own directory).
 * @returns the payload size in bytes.
 */
export function writeJsonAtomic(file: string, value: unknown, pretty = false): number {
  const tmp = `${file}.tmp-${process.pid}`
  const g = gateDestructive({
    targets: [tmp, file], whitelist: [dirname(file)], op: '搬移', scope: ['file'],
    allowProduction: true, allowReparse: false,
    reason: `task-board: atomic json write ${file}`,
  })
  if (!g.ok) throw new Error(`R-065 拒写/拒搬（${g.code ?? 'blocked'}）：${firstLine(g.reason)}`)
  mkdirSync(dirname(file), { recursive: true })
  const payload = JSON.stringify(value, null, pretty ? 2 : undefined)
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'w', 0o600)
    writeFileSync(fd, payload, { encoding: 'utf8' })
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    try { chmodSync(tmp, 0o600) } catch { /* Windows ACLs own access */ }
    renameWithRetry(tmp, file)
    try {
      const dirFd = openSync(dirname(file), 'r')
      try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
    } catch {
      // Windows does not permit fsync on a directory handle; rename remains atomic.
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    // 重试耗尽仍失败 ⇒ tmp 留着取证（renameWithRetry 已打 stderr），别当普通失败清掉。
    if (!isTmpPreserved(error)) {
      try { unlinkSync(tmp) } catch { /* best-effort temporary cleanup */ }
    }
    throw error
  }
  return Buffer.byteLength(payload, 'utf8')
}

function fileBytes(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** sha256 of one card's canonical JSON — the field-preservation witness of J3. */
export function cardDigest(card: unknown): string {
  return createHash('sha256').update(JSON.stringify(card)).digest('hex')
}

function parseManifest(value: unknown): ArchiveBatchManifest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (!isValidArchiveBatchId(row.batchId)) return undefined
  if (!Array.isArray(row.ids)) return undefined
  const ids = row.ids.filter((id): id is string => typeof id === 'string' && id !== '')
  const at = typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : 0
  return {
    batchId: row.batchId,
    at,
    count: typeof row.count === 'number' && Number.isSafeInteger(row.count) && row.count >= 0 ? row.count : ids.length,
    ids,
    fromRevision: typeof row.fromRevision === 'number' && Number.isSafeInteger(row.fromRevision) && row.fromRevision >= 0 ? row.fromRevision : 0,
    tool: typeof row.tool === 'string' && row.tool !== '' ? row.tool : 'unknown',
    host: typeof row.host === 'string' && row.host !== '' ? row.host : 'unknown',
    ...(typeof row.restoredAt === 'number' && Number.isFinite(row.restoredAt) ? { restoredAt: row.restoredAt } : {}),
  }
}

function parseIndexEntry(value: unknown): ArchiveBatchIndexEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (!isValidArchiveBatchId(row.batchId)) return undefined
  if (!Array.isArray(row.ids)) return undefined
  const ids = row.ids.filter((id): id is string => typeof id === 'string' && id !== '')
  return {
    batchId: row.batchId,
    at: typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : 0,
    count: typeof row.count === 'number' && Number.isSafeInteger(row.count) && row.count >= 0 ? row.count : ids.length,
    bytes: typeof row.bytes === 'number' && Number.isSafeInteger(row.bytes) && row.bytes >= 0 ? row.bytes : 0,
    path: typeof row.path === 'string' && row.path !== '' ? row.path : `${ARCHIVE_DIR_NAME}/${row.batchId}`,
    ids,
    ...(typeof row.restoredAt === 'number' && Number.isFinite(row.restoredAt) ? { restoredAt: row.restoredAt } : {}),
  }
}

/** Every readable batch on disk, oldest first. Unreadable directories are skipped. */
export function listArchiveBatches(boardDir: string): ArchiveBatchRecord[] {
  const root = archiveRoot(boardDir)
  if (!existsSync(root)) return []
  const out: ArchiveBatchRecord[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const manifest = parseManifest(readJsonValue(join(dir, 'manifest.json')))
    if (manifest === undefined) continue
    out.push({ manifest, dir, bytes: fileBytes(join(dir, 'cards.json')) })
  }
  return out.sort((a, b) => a.manifest.at - b.manifest.at || a.manifest.batchId.localeCompare(b.manifest.batchId))
}

function indexEntryFrom(record: ArchiveBatchRecord): ArchiveBatchIndexEntry {
  return {
    batchId: record.manifest.batchId,
    at: record.manifest.at,
    count: record.manifest.count,
    bytes: record.bytes,
    path: `${ARCHIVE_DIR_NAME}/${record.manifest.batchId}`,
    ids: [...record.manifest.ids],
    ...(record.manifest.restoredAt === undefined ? {} : { restoredAt: record.manifest.restoredAt }),
  }
}

/** Rebuild the whole index from the manifests — the repair path of 方案 §6 表 1. */
export function buildArchiveIndex(boardDir: string): ArchiveIndexDocument {
  return { schemaVersion: ARCHIVE_SCHEMA_VERSION, batches: listArchiveBatches(boardDir).map(indexEntryFrom) }
}

export interface ArchiveIndexState {
  batches: ArchiveBatchIndexEntry[]
  /** True when the cached index was missing or stale and got rewritten. */
  rebuilt: boolean
}

/**
 * Read `archive-index.json`, falling back to a rebuild whenever it disagrees
 * with the manifests. The index is a cache: a missing, malformed or stale copy
 * must never be able to hide a batch (that would silently "lose" cards), so
 * every mismatch is resolved in favour of the manifests.
 */
export function readArchiveIndex(boardDir: string): ArchiveIndexState {
  const rebuild = (): ArchiveIndexState => {
    const document = buildArchiveIndex(boardDir)
    writeJsonAtomic(archiveIndexFile(boardDir), document, true)
    return { batches: document.batches, rebuilt: true }
  }

  const raw = readJsonValue(archiveIndexFile(boardDir))
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return rebuild()
  const row = raw as Record<string, unknown>
  if (row.schemaVersion !== ARCHIVE_SCHEMA_VERSION || !Array.isArray(row.batches)) return rebuild()

  const batches: ArchiveBatchIndexEntry[] = []
  for (const value of row.batches) {
    const entry = parseIndexEntry(value)
    if (entry === undefined) return rebuild()
    batches.push(entry)
  }

  const disk = listArchiveBatches(boardDir)
  if (disk.length !== batches.length) return rebuild()
  for (const record of disk) {
    const cached = batches.find(entry => entry.batchId === record.manifest.batchId)
    if (cached === undefined) return rebuild()
    if (cached.count !== record.manifest.count) return rebuild()
    if (cached.bytes !== record.bytes) return rebuild()
    if (cached.ids.join('\n') !== record.manifest.ids.join('\n')) return rebuild()
  }
  return { batches, rebuilt: false }
}

/** Local-time batch stamp, mirroring the session archiver's directory shape. */
function localStamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
}

/**
 * Build a batch id that is unique on disk (`<prefix>-<local stamp>`, with a
 * numeric suffix if that name is taken).
 */
export function makeBatchId(prefix: string, at: number, boardDir: string): string {
  if (!/^[a-z0-9-]+$/.test(prefix)) throw new Error(`invalid archive batch prefix: ${String(prefix)}`)
  const base = `${prefix}-${localStamp(at)}`
  if (!isValidArchiveBatchId(base)) throw new Error(`invalid archive batch id: ${base}`)
  let candidate = base
  let suffix = 2
  while (existsSync(join(archiveRoot(boardDir), candidate)) && suffix < 100) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

/**
 * Write one batch: `cards.json`, then `manifest.json`, then the index (D-2).
 *
 * An existing batch directory is never overwritten: a repeated action must
 * produce a NEW batch, never rewrite history.
 */
export function writeArchiveBatch(boardDir: string, input: WriteArchiveBatchInput): ArchiveBatchManifest {
  const dir = batchDirOf(boardDir, input.batchId)
  if (existsSync(dir)) throw new Error(`archive batch already exists: ${input.batchId}`)
  mkdirSync(dir, { recursive: true })

  const cards = [...input.tasks]
  const cardsFile = join(dir, 'cards.json')
  writeJsonAtomic(cardsFile, cards, true)
  const bytes = fileBytes(cardsFile)
  input.onStage?.('cards-written')

  const manifest: ArchiveBatchManifest = {
    batchId: input.batchId,
    at: input.at,
    count: cards.length,
    ids: cards.map(task => task.id),
    fromRevision: input.fromRevision,
    tool: input.tool,
    host: input.host,
  }
  writeJsonAtomic(join(dir, 'manifest.json'), manifest, true)
  input.onStage?.('manifest-written')

  const index = readArchiveIndex(boardDir)
  const batches = [
    ...index.batches.filter(entry => entry.batchId !== manifest.batchId),
    indexEntryFrom({ manifest, dir, bytes }),
  ]
  writeJsonAtomic(archiveIndexFile(boardDir), { schemaVersion: ARCHIVE_SCHEMA_VERSION, batches }, true)
  input.onStage?.('index-written')
  return manifest
}

/** Cards stored in one batch (empty when the file is missing or unreadable). */
export function readBatchCards(boardDir: string, batchId: string): TaskRecord[] {
  const raw = readJsonValue(join(batchDirOf(boardDir, batchId), 'cards.json'))
  return Array.isArray(raw) ? raw as TaskRecord[] : []
}

/**
 * Locate the batch holding one card **through the index's `ids[]`**, never by
 * scanning every batch file (方案 §7 环 C ②).
 */
export function findBatchIdForCard(boardDir: string, taskId: string): string | undefined {
  return readArchiveIndex(boardDir).batches.find(entry => entry.ids.includes(taskId))?.batchId
}

/** Look up one index row without scanning the batches for it. */
export function findArchiveBatch(boardDir: string, batchId: string): ArchiveBatchIndexEntry | undefined {
  return readArchiveIndex(boardDir).batches.find(entry => entry.batchId === batchId)
}

export interface RemoveCardsResult {
  batchId: string
  removed: number
  remaining: number
  restoredAt?: number
}

/**
 * Take cards OUT of a batch (the second half of a restore). Called only after
 * the main ledger has been committed, so a crash here leaves a redundant batch
 * copy — never a card that exists nowhere. The batch files are never deleted;
 * a batch that runs empty is marked `restoredAt`.
 */
export function removeCardsFromBatch(
  boardDir: string,
  batchId: string,
  ids: readonly string[],
  now: number,
): RemoveCardsResult {
  const dir = batchDirOf(boardDir, batchId)
  const gone = new Set(ids)
  const cards = readBatchCards(boardDir, batchId).filter(card => !gone.has(card.id))

  const parsed = parseManifest(readJsonValue(join(dir, 'manifest.json')))
  if (parsed === undefined) throw new Error(`archive batch manifest is unreadable: ${batchId}`)

  const manifest: ArchiveBatchManifest = {
    ...parsed,
    count: cards.length,
    ids: parsed.ids.filter(id => !gone.has(id)),
    ...(cards.length === 0 ? { restoredAt: parsed.restoredAt ?? now } : {}),
  }

  writeJsonAtomic(join(dir, 'cards.json'), cards, true)
  const bytes = fileBytes(join(dir, 'cards.json'))
  writeJsonAtomic(join(dir, 'manifest.json'), manifest, true)

  const index = readArchiveIndex(boardDir)
  const row = indexEntryFrom({ manifest, dir, bytes })
  const batches = index.batches.some(entry => entry.batchId === batchId)
    ? index.batches.map(entry => (entry.batchId === batchId ? row : entry))
    : [...index.batches, row]
  writeJsonAtomic(archiveIndexFile(boardDir), { schemaVersion: ARCHIVE_SCHEMA_VERSION, batches }, true)

  return {
    batchId,
    removed: ids.length,
    remaining: cards.length,
    ...(manifest.restoredAt === undefined ? {} : { restoredAt: manifest.restoredAt }),
  }
}

/**
 * A directory under `archive/` with no usable manifest. It can only come from a
 * crash between the fixed write steps (D-2), so its cards are — by construction
 * — still in the main ledger; the plan still proves that id by id before it
 * allows a delete.
 */
export interface DamagedArchiveDir {
  name: string
  dir: string
  reason: string
  /**
   * Card ids read back from `cards.json`, or `undefined` when it is missing or
   * unreadable — in which case nothing can be proven and the directory must be
   * left alone.
   */
  cardIds?: string[]
  /** True when the directory holds nothing durable (empty, or temporaries only). */
  onlyTemporaries: boolean
  fileCount: number
}

const TEMP_SUFFIX_PATTERN = /\.tmp-\d+$/

function listDirEntries(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** `readdir` with dirents, or `undefined` when the directory cannot be read. */
function listDirEntriesWithTypes(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
}

function listDamagedArchiveDirs(boardDir: string): DamagedArchiveDir[] {
  const root = archiveRoot(boardDir)
  if (!existsSync(root)) return []
  const out: DamagedArchiveDir[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const manifestRead = readJson(join(dir, 'manifest.json'))
    if (manifestRead.ok && parseManifest(manifestRead.value) !== undefined) continue
    const files = listDirEntries(dir)
    // `every` on an empty list is true, so an empty directory counts as
    // "nothing durable" — exactly the state a crash right after mkdir leaves.
    const onlyTemporaries = files.every(name => TEMP_SUFFIX_PATTERN.test(name))
    const cardsRead = readJson(join(dir, 'cards.json'))
    const cardIds = cardsRead.ok && Array.isArray(cardsRead.value)
      ? (cardsRead.value as unknown[]).flatMap((card) => {
          if (typeof card !== 'object' || card === null) return []
          const id = (card as { id?: unknown }).id
          return typeof id === 'string' && id !== '' ? [id] : []
        })
      : undefined
    const manifestReason = manifestRead.ok ? 'manifest is unreadable' : `manifest.json: ${manifestRead.reason}`
    out.push({
      name: entry.name,
      dir,
      reason: files.length === 0
        ? 'empty batch directory (the writer stopped before its first file)'
        : onlyTemporaries
          ? 'temporary files only (the first atomic write never completed)'
          : cardIds === undefined
            ? `${manifestReason}, and cards.json is missing or unreadable`
            : `${manifestReason} while cards.json is present`,
      ...(cardIds === undefined ? {} : { cardIds }),
      onlyTemporaries,
      fileCount: files.length,
    })
  }
  return out
}

export type ArchiveCleanupKind = 'orphan' | 'partial' | 'healthy' | 'damaged' | 'damaged-unsafe'

export interface ArchiveCleanupEntry {
  batchId: string
  kind: ArchiveCleanupKind
  /** Cards the batch holds. */
  total: number
  /** ids that are still present in the main ledger — the batch copy is redundant. */
  overlapping: string[]
  /** ids that stay in the batch after the cleanup. */
  kept: string[]
  action: 'delete-batch' | 'trim-cards' | 'none'
  note?: string
}

export interface ArchiveCleanupPlan {
  entries: ArchiveCleanupEntry[]
  deletable: number
  trimmable: number
  /** Entries a human must look at: nothing proves their cards are still safe. */
  needsReview: number
}

/**
 * Plan the removal of batches whose cards are ALSO in the main ledger.
 *
 * That overlap is the only signature of a crash between the fixed write steps
 * (D-2): the batch was written, the main ledger commit never happened. A batch
 * whose cards are absent from the main ledger is healthy and is never touched.
 *
 * Pure read: nothing is written, so the default is a dry run (方案 §6 表 4).
 * @param liveIds - every task id currently held by the main ledger.
 */
export function planArchiveCleanup(boardDir: string, liveIds: ReadonlySet<string>): ArchiveCleanupPlan {
  const entries: ArchiveCleanupEntry[] = []

  for (const record of listArchiveBatches(boardDir)) {
    const { manifest } = record
    const overlapping = manifest.ids.filter(id => liveIds.has(id))
    const kept = manifest.ids.filter(id => !liveIds.has(id))
    if (overlapping.length === 0) {
      entries.push({ batchId: manifest.batchId, kind: 'healthy', total: manifest.count, overlapping, kept, action: 'none' })
      continue
    }
    const fullyRedundant = kept.length === 0
    entries.push({
      batchId: manifest.batchId,
      kind: fullyRedundant ? 'orphan' : 'partial',
      total: manifest.count,
      overlapping,
      kept,
      action: fullyRedundant ? 'delete-batch' : 'trim-cards',
      note: fullyRedundant
        ? 'every card of this batch is still in the main ledger (the commit never happened)'
        : `${kept.length} card(s) stay; ${overlapping.length} redundant copy/copies are dropped`,
    })
  }

  for (const damaged of listDamagedArchiveDirs(boardDir)) {
    if (damaged.onlyTemporaries) {
      entries.push({
        batchId: damaged.name,
        kind: 'damaged',
        total: 0,
        overlapping: [],
        kept: [],
        action: 'delete-batch',
        note: damaged.reason,
      })
      continue
    }
    const ids = damaged.cardIds
    if (ids === undefined) {
      entries.push({
        batchId: damaged.name,
        kind: 'damaged-unsafe',
        total: 0,
        overlapping: [],
        kept: [],
        action: 'none',
        note: `${damaged.reason} — nothing proves its cards are in the main ledger, left untouched for a human`,
      })
      continue
    }
    const stillLive = ids.filter(id => liveIds.has(id))
    const notLive = ids.filter(id => !liveIds.has(id))
    if (notLive.length === 0) {
      entries.push({
        batchId: damaged.name,
        kind: 'damaged',
        total: ids.length,
        overlapping: stillLive,
        kept: [],
        action: 'delete-batch',
        note: `${damaged.reason}; every card it lists is still in the main ledger`,
      })
      continue
    }
    entries.push({
      batchId: damaged.name,
      kind: 'damaged-unsafe',
      total: ids.length,
      overlapping: stillLive,
      kept: notLive,
      action: 'none',
      note: `${damaged.reason}; ${notLive.length} card(s) are absent from the main ledger — left untouched for a human`,
    })
  }

  return {
    entries,
    deletable: entries.filter(entry => entry.action === 'delete-batch').length,
    trimmable: entries.filter(entry => entry.action === 'trim-cards').length,
    needsReview: entries.filter(entry => entry.kind === 'damaged-unsafe').length,
  }
}

/**
 * Whether a directory tree contains a link. Deletion must never follow one:
 * `rmSync(recursive)` and `/MIR`-style copies walk INTO junctions and wipe the
 * link target (a real data-loss accident in this workspace). A batch directory
 * that contains a link is therefore skipped and reported instead.
 */
export function containsLink(dir: string): boolean {
  const entries = listDirEntriesWithTypes(dir)
  if (entries === undefined) return true // unreadable — treat as unsafe
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return true
    if (entry.isDirectory()) {
      try {
        if (lstatSync(join(dir, String(entry.name))).isSymbolicLink()) return true
      } catch {
        return true
      }
    }
  }
  return false
}

export interface ArchiveCleanupResult {
  deleted: string[]
  trimmed: string[]
  skipped: string[]
  /** R-065: true when the caller asked for a dry run (nothing was touched). */
  dryRun?: boolean
}

/**
 * Execute a plan. Callers default to a dry run; `--apply` is what gets here.
 * R-065 (lock batchD3): `opts.dryRun` is the **first** statement of this write
 * function (not just a CLI check), and every recursive delete goes through the
 * shared gate (whitelist = this board's archive root).
 * @param now - clock used for the `restoredAt` stamp of a trimmed-empty batch.
 */
export function applyArchiveCleanup(
  boardDir: string,
  plan: ArchiveCleanupPlan,
  now: number = Date.now(),
  opts: { dryRun?: boolean } = {},
): ArchiveCleanupResult {
  if (opts.dryRun === true) {                                   // ① 函数内第一道门
    return {
      deleted: [], trimmed: [], dryRun: true,
      skipped: plan.entries.filter((e) => e.action !== 'none').map((e) => e.batchId),
    }
  }
  const deleted: string[] = []
  const trimmed: string[] = []
  const skipped: string[] = []

  for (const entry of plan.entries) {
    if (entry.action === 'none') continue
    const dir = join(archiveRoot(boardDir), entry.batchId)
    if (containsLink(dir)) {
      skipped.push(entry.batchId)
      continue
    }
    if (entry.action === 'delete-batch') {
      const g = gateDestructive({                               // ② 三件套
        targets: [dir], whitelist: [archiveRoot(boardDir)], op: '删', scope: ['file'],
        allowProduction: true, allowReparse: false,
        reason: `task-board: delete archive batch ${entry.batchId}`,
      })
      if (!g.ok) {                                              // ③ fail-closed（跳过并可见）
        skipped.push(entry.batchId)
        continue
      }
      rmSync(dir, { recursive: true, force: true })
      deleted.push(entry.batchId)
      continue
    }
    removeCardsFromBatch(boardDir, entry.batchId, entry.overlapping, now)
    trimmed.push(entry.batchId)
  }

  if (deleted.length > 0) {
    // The index is a cache rebuilt from the manifests: re-derive it so the
    // removed rows cannot linger.
    writeJsonAtomic(archiveIndexFile(boardDir), buildArchiveIndex(boardDir), true)
  }
  return { deleted, trimmed, skipped }
}

export interface ArchiveStatusSummary {
  batches: number
  cards: number
  bytes: number
  restoredBatches: number
  damagedDirectories: number
}

/** Read-only summary for the board panel / CLI. */
export function summarizeArchive(boardDir: string): ArchiveStatusSummary {
  const batches = listArchiveBatches(boardDir)
  return {
    batches: batches.length,
    cards: batches.reduce((sum, record) => sum + record.manifest.count, 0),
    bytes: batches.reduce((sum, record) => sum + record.bytes, 0),
    restoredBatches: batches.filter(record => record.manifest.restoredAt !== undefined).length,
    damagedDirectories: listDamagedArchiveDirs(boardDir).length,
  }
}
