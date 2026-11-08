/**
 * Archive batch id rules, shared by the wire protocol and the archive store.
 *
 * A batch id becomes a directory name under `task-board/archive/`, and
 * `restore-many` carries one straight from a client, so its shape is validated
 * on BOTH sides: the protocol refuses a malformed id at parse time (a 400
 * instead of a path-traversal attempt) and the store re-checks before it
 * touches the filesystem.
 *
 * Kept dependency-free on purpose: `protocol.ts` is imported by the browser
 * client, so anything it pulls in must stay free of node built-ins.
 */
const ARCHIVE_BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Whether an unknown value is usable as an archive batch id / directory name. */
export function isValidArchiveBatchId(value: unknown): value is string {
  return typeof value === 'string' && ARCHIVE_BATCH_ID_PATTERN.test(value) && !value.includes('..')
}
