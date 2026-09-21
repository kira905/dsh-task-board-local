/**
 * scan-oss-sanitize.mjs — pre-publish sanitization scan (read-only).
 *
 * Usage:
 *   node scan-oss-sanitize.mjs [--dir <path>] [--deny-words "a,b"]
 *                              [--deny-file <path>] [--reportPath <md>]
 *                              [--reveal] [--quiet] [--json]
 *
 * Judgement model (same line as the documentation-repo scanner):
 *   pattern hit -> per-hit judgement -> "allowed (reason)" or "needs review".
 *   Nothing may be published while **needs review > 0**.
 *
 * Two properties of this scanner are deliberate:
 *
 * 1. The rule table below contains **no machine-identifying literal** — no host
 *    name, user name, account name, colleague-team codename or private
 *    component name. Words of that kind arrive from outside through
 *    `--deny-words` / `--deny-file` / `$OSS_DENY_WORDS`, so the rule table can
 *    be published without publishing anything private.
 * 2. Because of (1) the scanner may scan itself. It does skip its own file when
 *    walking the tree: the rule table necessarily spells out generic pattern
 *    literals such as a credential prefix or an env-var marker, and those would
 *    otherwise be reported as hits against the scanner. A public, readable rule
 *    table is the evidence that nothing was smuggled in.
 *
 * Output is masked by default (first 12 characters of a hit); pass `--reveal`
 * on a local run when the raw text is needed for triage. This keeps a committed
 * report safe to publish.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}

const SELF = fs.realpathSync(fileURLToPath(import.meta.url))
const SCRIPT_DIR = path.dirname(SELF)
const DIR = path.resolve(opt('dir', SCRIPT_DIR))
const QUIET = argv.includes('--quiet')
const AS_JSON = argv.includes('--json')
const REVEAL = argv.includes('--reveal')
const REPORT_PATH = opt('reportPath', path.join(DIR, 'oss-sanitize-report.md'))

const SKIP_DIRS = new Set(['node_modules', '.git', '.dsh', '_archive', 'dist', 'coverage'])
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts', '.jsx',
  '.json', '.md', '.markdown', '.css', '.yml', '.yaml', '.txt',
  '.html', '.map', '.sh', '.ps1', '.cmd', '.bat', '.toml',
])
/**
 * Extension-less text files that must not be skipped — the compliance files
 * (LICENSE, NOTICE) and the repo dotfiles have no extension, and silently
 * overlooking exactly the files that carry attribution would be the worst
 * possible blind spot.
 */
const TEXT_NAMES = new Set(['license', 'licence', 'notice', 'readme', 'gitignore', 'gitattributes', 'dockerfile', 'makefile'])

/** Whether a file name should be scanned as text. */
function isTextFile(name) {
  const lower = name.toLowerCase()
  if (TEXT_EXT.has(path.extname(lower))) return true
  return TEXT_NAMES.has(lower.replace(/^\./, ''))
}

/** Words that identify the build machine or the private side; injected. */
function denyWords() {
  const words = []
  const push = (raw) => {
    for (const chunk of String(raw ?? '').split(',')) {
      const t = chunk.trim()
      if (t !== '') words.push(t)
    }
  }
  push(opt('deny-words', ''))
  push(process.env.OSS_DENY_WORDS ?? '')
  const file = opt('deny-file', '')
  if (file !== '' && fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim()
      if (t !== '' && !t.startsWith('#')) words.push(t)
    }
  }
  return [...new Set(words)]
}

const DENY = denyWords()

/**
 * A hit is allowed only when its line carries an explicit, reviewable reason.
 * Rule ids are quoted in the report so every waiver can be argued with.
 */
const ALLOW = [
  {
    id: 'A1',
    why: 'upstream attribution / license statement (required by Apache-2.0 §4)',
    re: /Apache-2\.0|apache license|upstream|Upstream|fork|Fork|derivative|衍生|来源|NOTICE|attribution|Licensed under/i,
  },
  {
    id: 'A2',
    why: 'public DSH host convention (documented home dir / default web port)',
    re: /DSH_HOME|DSH_WEB_URL|~\/\.dsh|localhost:3080|127\.0\.0\.1:3080|http:\/\/localhost/,
  },
  {
    id: 'A3',
    why: 'public upstream project reference (package name / repository URL)',
    re: /@linxin666\/dsh-client-ui-task-board|github\.com\/zhu1090093659\/dsh-web|@dickpy\/dsh-imagegen/,
  },
  {
    id: 'A4',
    why: 'owner attribution line in an explicit authorship context',
    re: /copyright|©|署名|author|maintainer|owner/i,
  },
  {
    id: 'A5',
    why: 'public project reference (already published repositories / document titles)',
    re: /ops-handoff-design|dsh-archive-sessions|dsh-butler-archive|自治式运维管家|多机交接与云中继|体系全景与家规|Autonomous Operations Steward|Multi-machine Handoff/,
  },
]

/** Structural patterns only — safe to publish. Host words are appended last. */
function patterns() {
  const list = [
    { id: 'P1', label: 'user profile directory / environment variable', re: /Users[\\/][A-Za-z0-9._-]+|%USERPROFILE%|%TEMP%|%APPDATA%|\$env:[A-Za-z_]+/g },
    { id: 'P2', label: 'drive-letter absolute path', re: /(?:^|[^A-Za-z0-9:.])(?:[A-H]):[\\/]/g },
    { id: 'P3', label: 'session id / uuid / long hash', re: /session-[0-9a-f]{6,}|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{32,}\b/g },
    { id: 'P4', label: 'credential shape', re: /(?<![A-Za-z])sk-[A-Za-z0-9]{4,}|(?<![A-Za-z])gho_[A-Za-z0-9]{4,}|(?<![A-Za-z])ghp_[A-Za-z0-9]{4,}|github_pat_|BEGIN [A-Z ]*PRIVATE KEY/gi },
    { id: 'P5', label: 'private network address', re: /\b(?:10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
  ]
  if (DENY.length > 0) {
    // Word-boundary guard for plain ASCII terms: without it a short codename
    // would match inside a longer English word (a three-letter code inside
    // "progress", say), producing noise that buries the real hits. Terms
    // containing non-ASCII characters (Chinese words) are matched literally —
    // \b has no meaning there.
    const escaped = DENY.map((w) => {
      const e = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return /^[A-Za-z0-9_.\-]+$/.test(w) ? `\\b${e}\\b` : e
    })
    list.push({
      id: 'P0',
      label: 'injected deny list (--deny-words / --deny-file / $OSS_DENY_WORDS)',
      re: new RegExp(escaped.join('|'), 'gi'),
    })
  }
  return list
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, out)
    } else if (entry.isFile()) {
      if (fs.realpathSync.native !== undefined) {
        // Skip the scanner itself (see the header note).
        try {
          if (fs.realpathSync(full) === SELF) continue
        } catch { /* unreadable entry: fall through and let the read fail */ }
      }
      if (isTextFile(entry.name)) out.push(full)
    }
  }
  return out
}

function mask(text) {
  if (REVEAL) return text
  const head = text.slice(0, 12)
  return text.length > 12 ? head + '…' : head
}

function allowedBy(line) {
  for (const rule of ALLOW) {
    if (rule.re.test(line)) return rule
  }
  return null
}

function scan() {
  const files = walk(DIR).sort()
  const PATTERNS = patterns()
  const hits = []
  for (const file of files) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const rel = path.relative(DIR, file).split(path.sep).join('/')
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line === '') continue
      // A sourcemap or minified bundle line can be megabytes long; a hit is
      // judged from a bounded window so one giant line cannot stall the scan.
      const probe = line.length > 4000 ? line.slice(0, 4000) : line
      for (const p of PATTERNS) {
        p.re.lastIndex = 0
        const m = p.re.exec(probe)
        if (m === null) continue
        const allow = allowedBy(line)
        hits.push({
          file: rel,
          line: i + 1,
          pattern: p.id,
          label: p.label,
          match: mask(m[0]),
          snippet: mask(line.length > 200 ? line.slice(0, 200) : line),
          verdict: allow === null ? 'review' : 'allow',
          reason: allow === null ? '' : `${allow.id}: ${allow.why}`,
        })
      }
    }
  }
  return { files, hits }
}

function main() {
  if (!fs.existsSync(DIR)) {
    console.error('scan directory does not exist: ' + DIR)
    process.exitCode = 2
    return
  }
  const { files, hits } = scan()
  const review = hits.filter((h) => h.verdict === 'review')
  const allow = hits.filter((h) => h.verdict === 'allow')

  const byPattern = new Map()
  for (const h of hits) {
    const cur = byPattern.get(h.pattern) ?? { pattern: h.pattern, label: h.label, total: 0, review: 0 }
    cur.total += 1
    if (h.verdict === 'review') cur.review += 1
    byPattern.set(h.pattern, cur)
  }

  const L = []
  L.push('# 脱敏扫描报告（scan-oss-sanitize.mjs）')
  L.push('')
  L.push(`- 扫描目录：\`${DIR}\``)
  L.push(`- 扫描文件：${files.length} 个（文本类；跳过 node_modules / .git / _archive 与扫描器自身）`)
  L.push(`- 命中：${hits.length}（放行 ${allow.length} / 待复核 ${review.length}）`)
  L.push(`- 注入的私有标识词表（P0）：${DENY.length === 0 ? '未提供 ⇒ P0 段未启用（**本次扫描不完整，请补词表后重跑**）' : DENY.length + ' 条'}`)
  L.push(`- 输出模式：${REVEAL ? '明文（--reveal）' : '掩码（默认，报告可安全入仓）'}`)
  L.push('')
  L.push('## 判定结论')
  L.push('')
  L.push(review.length === 0
    ? (DENY.length === 0 ? '⚠️ **待复核 = 0，但词表为空 ⇒ 结论不成立**' : '✅ **待复核 = 0 ⇒ 可发布**')
    : `❌ **待复核 = ${review.length} ⇒ 不可发布**`)
  L.push('')
  L.push('## 按模式统计')
  L.push('')
  L.push('| 模式 | 含义 | 命中 | 其中待复核 |')
  L.push('| --- | --- | --- | --- |')
  for (const row of [...byPattern.values()].sort((a, b) => a.pattern.localeCompare(b.pattern))) {
    L.push(`| ${row.pattern} | ${row.label} | ${row.total} | ${row.review} |`)
  }
  L.push('')
  if (review.length > 0) {
    L.push('## 待复核明细')
    L.push('')
    L.push('| 文件 | 行 | 模式 | 命中 | 行内容（截断） |')
    L.push('| --- | --- | --- | --- | --- |')
    for (const h of review) {
      L.push(`| ${h.file} | ${h.line} | ${h.pattern} | \`${h.match}\` | \`${h.snippet.replace(/\|/g, '\\|')}\` |`)
    }
    L.push('')
  }
  L.push('## 放行明细（每条带理由）')
  L.push('')
  L.push('| 文件 | 行 | 模式 | 命中 | 放行理由 |')
  L.push('| --- | --- | --- | --- | --- |')
  for (const h of allow) {
    L.push(`| ${h.file} | ${h.line} | ${h.pattern} | \`${h.match}\` | ${h.reason} |`)
  }
  L.push('')

  const report = L.join('\n')
  console.log(QUIET
    ? `files=${files.length} hits=${hits.length} allow=${allow.length} review=${review.length} denyWords=${DENY.length}`
    : report)
  if (AS_JSON) {
    console.log(JSON.stringify({
      dir: DIR, fileCount: files.length, hitCount: hits.length,
      reviewCount: review.length, allowCount: allow.length, denyWordCount: DENY.length,
      byPattern: [...byPattern.values()], review, allow,
    }, null, 2))
  }
  if (REPORT_PATH !== '') {
    fs.writeFileSync(REPORT_PATH, report, 'utf8')
    if (!QUIET) console.log(`\n报告：${REPORT_PATH}`)
  }

  const clean = review.length === 0 && DENY.length > 0
  process.exitCode = clean ? 0 : 3
}

main()
