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
  '.html', '.map', '.sh', '.ps1', '.cmd', '.bat', '.toml', '.py',
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
 *
 * Narrowing notes (added 2026-10-16). Both notes **tighten** the table; neither
 * introduces a new blanket pass:
 *
 * 1. A generic wording (`upstream`, `fork`, `owner`, `来源`, `署名` …) may no
 *    longer exempt a line on its own. It has to share the line with a real
 *    public reference: a repository URL, a license term, a published
 *    identifier (the same list A5 uses) or an explicit authorship field
 *    (`owner:` / `署名：`). Previously a bare keyword waved through any
 *    sentence of ordinary prose, a machine name on the same line included.
 *    Rules A2/A3/A5/A6 are unaffected: they match concrete literals
 *    (`~/.dsh`, a package name, a published repo name, `%VAR%`), not wording.
 * 2. A generated artifact's provenance fingerprint line is exempt, but only
 *    when the **whole** line is that single field (A7). A long hex anywhere
 *    else is still reported.
 * 3. A5 keeps its literal list but no longer exempts a whole line (2026-10-16).
 *    It excuses a hit only when **every** occurrence of that hit pattern on the
 *    line falls inside a public reference — an already-published repository /
 *    document title, or a public URL / `git@host:path` remote. A published repo
 *    name therefore still excuses that name itself (and the account name at the
 *    start of a repository URL), while anything else sharing the line — a
 *    machine name, a drive letter, a credential shape, a private address —
 *    turns that line into "needs review".
 */
/** Published repositories / document titles — shared by A5 and by the A1c/A4c context. */
const PUBLISHED_SRC = 'ops-handoff-design|dsh-archive-sessions|dsh-butler-archive|自治式运维管家|多机交接与云中继|体系全景与家规|Autonomous Operations Steward|Multi-machine Handoff|dsh-session-toolkit|dsh-session-title-live|dsh-ecosystem-panel|dsh-firstaid|dsh-diagnostic-tools|dsh-task-board-local'
/** "Public context" lookahead shared by the conditional rules A1c / A4c. */
const PUBLIC_CONTEXT = '(?=.*(?:https?://|github\\.com/|gitee\\.com/|git@|(?:' + PUBLISHED_SRC + ')|\\bLICEN[CS]E\\b|Apache-2\\.0|\\bMIT\\b|\\bAGPL\\b|CC BY|许可证|许可|(?:owner|author|maintainer|署名)\\s*[:=：]))'
/**
 * Public reference spans used by the narrowed A5 (see note 3): a public URL
 * (http/https) or an SCP-style git remote (`git@host:path`). Together with
 * PUBLISHED_SRC these say where a hit may be excused.
 */
const PUBLIC_REF = /https?:\/\/[^\s<>"'`)\]}]+|git@[^\s<>"'`)\]}]+/g
const ALLOW = [
  {
    id: 'A1',
    why: 'license statement wording (the term itself is the compliance wording, required by Apache-2.0 §4)',
    re: /Apache-2\.0|apache license|Licensed under|SPDX-License-Identifier|\bNOTICE\b/i,
  },
  {
    id: 'A1c',
    why: 'upstream / derivation wording, only when the same line carries a public reference (URL, license term, published identifier or authorship field) — a bare keyword no longer exempts the line',
    re: new RegExp(PUBLIC_CONTEXT + '(?:\\b(?:upstream|fork|derivative|attribution)\\b|衍生|来源)', 'i'),
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
    why: 'copyright notice wording (the term itself is the compliance wording)',
    re: /copyright|©|版权/i,
  },
  {
    id: 'A4c',
    why: 'authorship wording, only when the same line carries a public reference or an explicit authorship field (`owner:` / `author=` / `署名：`) — a bare keyword no longer exempts the line',
    re: new RegExp(PUBLIC_CONTEXT + '(?:\\b(?:author|maintainer|owner)s?\\b|署名)', 'i'),
  },
  {
    id: 'A5',
    why: 'public project reference (already published repositories / document titles) — narrowed 2026-10-16: a hit is excused only when the hit itself sits inside such a reference (a published identifier, or a public URL / git remote that carries it); A5 never exempts the whole line',
    re: new RegExp(PUBLISHED_SRC),
  },
  {
    id: 'A6',
    why: 'cross-platform environment variable name (a variable NAME carries no machine-specific value: %VAR% or $env:VAR style)',
    re: /%APPDATA%|%LOCALAPPDATA%|%USERPROFILE%|%TEMP%|%ProgramFiles%|%ProgramData%|\$env:[A-Za-z_][A-Za-z0-9_]*/i,
  },
  {
    id: 'A7',
    // 2026-10-20：从「整行只有一个 sourceSha256 字段」放宽到「内容摘要字段/常量形态」。
    // 触发条件由 `a7DigestHit()` 在 allowedBy 里逐条判（**只对 P3 长 hash 生效**，且整行不得含
    // 盘符/用户目录/环境变量/@/协议/反斜杠）⇒ 同行夹带的机器名（P0）、路径（P2）仍会被各自规则拦。
    why: 'content digest field (a 64-hex sha256 that points at the source it was built from; carries no machine information) — exempt only for P3 hits, only when the rest of the line holds nothing machine-like (no drive path / user dir / env var / @ / URL / backslash)',
    re: /\b[0-9a-f]{64}\b/i,
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

/**
 * Narrowed A5 (note 3): A5 no longer exempts a whole line. It excuses a hit only
 * when **every** occurrence of that hit pattern on the line is excused — i.e.
 * sits inside a published identifier (PUBLISHED_SRC) or a public URL / git
 * remote (PUBLIC_REF). Checking every occurrence, not just the recorded first
 * one, is what keeps `dsh-butler-archive on <host>` from slipping through: there
 * the first deny-word match is the repo name itself and would pass on its own.
 */
function publicRefSpans(line) {
  const spans = []
  for (const re of [new RegExp(PUBLISHED_SRC, 'g'), new RegExp(PUBLIC_REF.source, 'g')]) {
    for (const m of line.matchAll(re)) spans.push({ start: m.index, end: m.index + m[0].length })
  }
  return spans
}

/** Excused = the hit itself sits inside a public reference span. */
function excusedHit(spans, m) {
  const text = m[0]
  if (text === '') return false
  for (const s of spans) if (m.index >= s.start && m.index + text.length <= s.end) return true
  return false
}

/** A5 applies only when every occurrence of this hit pattern on the line is excused. */
function a5Covered(probe, pattern, match) {
  const spans = publicRefSpans(probe)
  if (!excusedHit(spans, match)) return false
  const flags = pattern.re.flags.includes('g') ? pattern.re.flags : pattern.re.flags + 'g'
  for (const m of probe.matchAll(new RegExp(pattern.re.source, flags))) {
    if (!excusedHit(spans, m)) return false
  }
  return true
}

/**
 * A7（2026-10-20 放宽）：内容摘要豁免。
 * 为什么放宽：fork 溯源记录（`FORK-BASE.json` 的 sha256/dtsSha256/patchSha256）与回滚脚本里的
 * 改动前后摘要（`const BEFORE = { sha: '<64hex>', bytes, label }` / 注释里的 `BEFORE: <64hex>`）
 * 都是**公开上游文件的内容指纹**，不含任何机器信息，但旧 A7 只认"整行就一个 sourceSha256 字段"，
 * 于是这些行被判待复核 ⇒ 整包发不出去。
 *
 * 放宽的边界（**只对 P3 长 hash 命中生效**，这一点是关键）：
 *   ① 命中本身必须是 64 位 hex；
 *   ② 整行不得含：盘符路径 / 用户目录 / %VAR% 或 $env: / `@` / `://` / 反斜杠；
 *   ③ 去掉 64-hex 后剩下的字符只能是"字段名 + 标点 + 数字 + 中文标签"这一小撮。
 * ⇒ 同一行里若夹带真机名（P0）、session id 或 uuid（P3 另一次命中）、私网地址（P5），
 *   那些命中**各自照旧判待复核**，不会被 A7 顺带放行。
 */
function a7DigestHit(probe, pattern, match) {
  if (pattern.id !== 'P3') return false
  if (!/^[0-9a-f]{64}$/i.test(match[0])) return false
  // 同一行还有"另一个 P3 形状的机器 id"（session id / uuid）⇒ 不放行：P3 每行只记第一处命中，
  // 若把整行放掉，后面那处 session id 就再也不会被报出来。
  if (/session-[0-9a-f]{6,}|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(probe)) return false
  if (/[A-Za-z]:[\\/]|Users[\\/]|\$env:|%[A-Za-z_]+%|@|:\/\/|\\/.test(probe)) return false
  // 注释起止符（/* 、*/、行首 //）不算"斜杠用途"，先抹掉再做字符面判定；其它斜杠（路径 / URL）一律拒。
  const rest = probe
    .replace(/^\s*\/{2,}\s*/, ' ')
    .replace(/\/\*+|\*+\//g, ' ')
    .replace(/\b[0-9a-f]{64}\b/gi, '\u27e8digest\u27e9')
  return /^[\s\w"'`:,.{}\[\]()=+*|#<>\u27e8\u27e9\-\u2014\u2013\u3001\u3002\uff08\uff09\uff0c\uff1a\uff1b\uff01\uff1f\u4e00-\u9fff]*$/u.test(rest)
}

function allowedBy(line, probe, pattern, match) {
  for (const rule of ALLOW) {
    if (!rule.re.test(line)) continue
    // A5 是唯一"不再整行放行"的规则（note 3）。
    if (rule.id === 'A5' && !a5Covered(probe, pattern, match)) continue
    // A7 有额外守卫：只对 P3 内容摘要命中生效（见 a7DigestHit）。
    if (rule.id === 'A7' && !a7DigestHit(probe, pattern, match)) continue
    return rule
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
        const allow = allowedBy(line, probe, p, m)
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
