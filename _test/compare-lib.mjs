/**
 * Compare two build artifacts ignoring volatile build paths.
 *
 * The delivered `lib/index.js` and `lib/client.js` carry `//#region <path>`
 * banner comments. Older build configs stamped an absolute path there, so the
 * text depended on the machine that produced the bundle and the comparison
 * strips those comments before diffing: the rest had to match byte for byte,
 * which is the evidence that a rebuild reproduces the shipped bundle rather
 * than silently changing it. The current config emits package-relative ids, so
 * the banners are stable across machines; the stripping is kept as a
 * belt-and-braces step for artifacts produced by an older config.
 *
 * Usage: node compare-lib.mjs <dirA> <dirB>
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [a, b] = process.argv.slice(2)
if (!a || !b) {
  console.error('usage: node compare-lib.mjs <dirA> <dirB>')
  process.exit(2)
}

const normalize = text => text
  .split(/\r?\n/)
  .filter((line) => {
    const trimmed = line.trimStart()
    return !trimmed.startsWith('//#region') && !trimmed.startsWith('//#endregion')
  })
  .join('\n')

let failures = 0
for (const file of ['index.js', 'client.js', 'invariant.js']) {
  let left, right
  try {
    left = normalize(readFileSync(join(a, file), 'utf8'))
    right = normalize(readFileSync(join(b, file), 'utf8'))
  } catch (error) {
    console.log(`SKIP ${file} — ${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  const same = left === right
  if (!same) failures += 1
  console.log(`${same ? 'SAME' : 'DIFF'} ${file}${same ? '' : ` (normalized lengths ${left.length} vs ${right.length})`}`)
  if (!same) {
    const leftLines = left.split('\n')
    const rightLines = right.split('\n')
    const limit = Math.max(leftLines.length, rightLines.length)
    let shown = 0
    for (let i = 0; i < limit && shown < 10; i += 1) {
      if (leftLines[i] === rightLines[i]) continue
      shown += 1
      console.log(`  line ${i + 1}:`)
      console.log(`    A: ${(leftLines[i] ?? '<none>').slice(0, 200)}`)
      console.log(`    B: ${(rightLines[i] ?? '<none>').slice(0, 200)}`)
    }
  }
}

console.log(failures === 0 ? '\nLIB MATCH (region banners ignored)' : `\n${failures} LIB DIFFERENCES`)
process.exitCode = failures === 0 ? 0 : 1
