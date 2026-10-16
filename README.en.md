# dsh-task-board-local

> **Status**: published · latest release `v1.1.1` (Gitee + GitHub)
> **Repository**: <https://github.com/kira905/dsh-task-board-local> ｜ <https://gitee.com/kira905/dsh-task-board-local>
> **Upstream**: `@linxin666/dsh-client-ui-task-board` 0.3.4 (Apache-2.0) — this is a **detached fork**: it does not follow upstream releases and versions independently from 1.0.0 on
> **License**: Apache-2.0 — see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE) (the NOTICE carries the upstream attribution and the statement of changes)
> **中文**: [README.md](./README.md)

A task board for the DSH Web GUI where **one card = one real DSH session**, and where **the run does not declare itself finished — a human does**.

## Design basis

This component is one implementation of the system described in
[ops-handoff-design](https://github.com/kira905/ops-handoff-design):

- **Why it exists and where its boundary is** → see *Autonomous Operations Steward* §4 (three object types + the autonomy spectrum): what may be handed to an agent, and where a human gate must stay
- **Its compatibility window with the host** → see *Multi-machine Handoff and Cloud Relay* §4.5 "compatibility requirements" (four rules): declare a supported range and probe at runtime instead of binding statically
- **This component's own pitfalls and measurements** → the "Known limitations" section below; the upstream project's issue tracker
- **How its completion / interruption judgments work, and how they fail** → see *Telling a "finished" task card from a lie, and an interrupted session from a closed one*: what an empty execution record actually means (three legitimate causes), the three cross-evidence checks for "did this card really get done", and why "interrupted" must be judged from the **tail event chain** rather than from the last event

## What this is / who it is for / how to read it

- **Who it is for**: people who want a long-running agent to genuinely *take work → do it → be accepted*, especially anyone already burned by "the agent said it was done, it was not".
- **How to read it**: start with "Differences from upstream" (that is where this fork's value is), then "Known limitations" (what this plugin does **not** promise), then "Install".
- **Three counter-intuitive points**:
  1. **Cards cost money**: running a card opens a separate DSH session and consumes the same API quota as any other session. The board is a **budget**, not a to-do list.
  2. **The executor cannot settle itself**: a successful settlement parks the card in **Review**; a human must confirm, or reject it back to To do with a reason.
  3. **The browser is only a view**: closing the page does not stop host scheduling, session creation or settlement; reopening the page fetches a full snapshot again.

## Differences from upstream

This fork started from upstream **0.3.4** and **no longer follows upstream releases**. The delta below was measured by comparing this repository's `src/` tree file by file against the `src/` tree shipped inside the upstream npm package (upstream publishes its sources, so no git history is needed).

**Summary**: upstream 43 files / this fork 45; identical **21**; changed **22**; added **2**; removed **0**.

### Files added (absent upstream)

| File | Why it exists |
| --- | --- |
| `src/settings-compat.ts` | Settings-service compatibility across host versions: probe old and new signatures at runtime so a host upgrade cannot break plugin startup |
| `src/client/client-faces.ts` | Runtime "faces" declared locally by the browser half, so the client bundle no longer needs the dsh-* client packages at runtime |

### Files changed (what was added)

| File | Upstream → fork (lines) | What was added |
| --- | --- | --- |
| `core/tasks.ts` | 290 → 428 (+103 −14) | **Human acceptance gate** (`review` status); **card kinds** `once` / `recurring` / `interactive` (with backward inference for cards written before the fork); **work-stream lines** (`line` / `seq`) and their ordering |
| `host-runner.ts` | 167 → 459 (+274 −50) | Settlement hardening: a new `interrupted` outcome; `inspect` reads session history directly instead of only the tail; **stale "fake running" recovery**; large pages are never spread as arguments |
| `host-service.ts` | 236 → 284 (+57 −11) | Settlement routing for the outcomes above: success parks in Review, interrupted/stuck runs converge, cards no longer sit in `running` for ever |
| `host-ledger.ts` | 776 → 852 (+64 −10) | Acceptance actions (confirm/reject) recorded in the ledger; a rejection reason is appended to the card description; notes stay editable on executed cards |
| `protocol.ts` | 221 → 239 (+22 −6) | Protocol fields and actions for the acceptance gate and card kinds |
| `index.ts` | 151 → 207 (+53 −10) | Host-side capability prompt for the plugin; the host adapter became an external runtime dependency |
| `core/controller.ts` | 566 → 649 (+57 −4) | Acceptance actions and line-view state; **event stream subscribed on demand** (no connection held while the board is not visible) |
| `core/store.ts` | 230 → 251 (+19 −2) | Local view storage for the new fields |
| `core/use-cases/task-update.ts` | 81 → 105 (+27 −9) | "Executed cards may only change their note" rule (title/prompt become read-only after a run) |
| `client/board/TaskBoard.tsx` | 158 → 296 (+120 −8) | **Line view** (columns per `line`, column header shows completion) and the status/line switch |
| `client/board/TaskDetail.tsx` | 420 → 551 (+90 −4) | Accept/reject controls, rejection note, card-kind editor, execution history |
| `client/board/NewTaskModal.tsx` | 219 → 274 (+83 −47) | Card kind and line/seq fields in the create form |
| `client/board/EditTaskModal.tsx` | 95 → 103 (+14 −8) | Read-only title/prompt after execution; only the note stays editable |
| `client/board/TaskCard.tsx` | 89 → 121 (+29 −4) | Line badge, card kind and acceptance state on the card face |
| `client/board/status-key.ts` | 12 → 13 (+1) | Locale key for the new Review column |
| `client/board.module.css` | 1130 → 1292 (+57) | Styles for the acceptance gate and line badges |
| `client/locales.ts` | 282 → 341 (+59) | New copy (acceptance / kinds / lines), Chinese and English |
| `client/index.ts` | 213 → 225 (+14 −4) | Gated subscription wiring + local faces |
| `client/host-api.ts` | 105 → 111 (+12 −5) | `subscribe()` reduced to opening/closing the stream (visibility policy moved up) |
| `client/sidebar-entry-core.ts` | 209 → 236 (+29 −4) | Sidebar entry row rendered like the host's own "new session" button (pill when expanded, icon when collapsed) |
| `client/settings-form.ts` | 454 → 459 (+7 −2) | Notes on where this copy diverges from the upstream-synced slice |
| `client/TaskBoardSettingsCard.tsx` | 180 → 217 (+37 −6) | Power-status row gated by visibility; uses the local faces |

> How to re-run the comparison (read-only): take the `src/` tree of any `@linxin666/dsh-client-ui-task-board@0.3.4` tarball and compare it file by file with this repository's `src/`; the summary and per-file line counts above are that measurement. Later upstream versions were **not** merged (npm registry `latest` was 0.3.24 when checked on 2026-09-21; upstream is still actively iterating).

### Boundaries that do not move

- **No back-porting**: this fork does not push changes upstream and does not follow upstream version numbers.
- **No machine coupling**: no host paths, host names, accounts or private component names appear in the code (see the sanitization scan in "Development and self-checks").

## Install

This repository is **not on npm** at the moment. Two routes:

**A. Build from source and mount locally** (the route that works today)

```bash
git clone <this-repo> dsh-task-board-local
cd dsh-task-board-local
npm install
npm run build          # emits lib/index.js (host half) and lib/client.js (browser half)
```

Then place the directory inside the target profile's `node_modules`
(`$DSH_HOME/profiles/web/node_modules/dsh-task-board-local`), insert the plugin into the profile's
bundle layer as shown in this repository's `cordis.patch.yml`, and restart `dsh web`
(or simply reload the page — the browser half is served per request).

**B. Once it is published to npm**

```bash
dsh plugin --profile web add dsh-task-board-local@<version>
```

**Supported host range**: `dsh >= 0.1.1-rc.1` (same declaration as upstream). Day-to-day this fork
runs on **0.1.1-rc.2**; the code probes at runtime for the newer lines (split packages, the new
settings-service signature) but has **not been tested on them** — before switching lines, exercise
create / run / accept in your own environment.

## Configuration

- The ledger lives at `$DSH_HOME/task-board/ledger-v2.json` (host-authoritative; the browser only submits actions).
- Each card can pin a **workspace / agent preset / permission**. If any pin cannot be applied (missing workspace, broken preset, rejected permission) the run **fails before the prompt is sent** — there is no half-started run.
- Cron is 5-field, in the **host's local time zone**. Missed occurrences are **not** caught up; `nextRunAt` rolls forward from the current host time.
- Optional and **off by default**: idle-sleep protection (`preventIdleSleep`). It blocks idle system sleep only; display sleep and lock are allowed, and lid close / manual sleep / hibernation / shutdown are outside the guarantee.

## Known limitations

- Running a card consumes API quota, exactly like an ordinary agent session.
- A card never runs concurrently: while one run is active, a due occurrence is skipped and the schedule rolls to the next cron match.
- Occurrences missed while the host is down or the system is asleep are never replayed.
- DST follows the host wall clock: a nonexistent spring-forward minute is skipped, a repeated fall-back minute is not replayed.
- Power protection covers idle system sleep only; every other power behaviour is the system's policy.
- Settlement depends on session history being readable: when it cannot be read the card stays in `running` rather than guessing (better stuck than wrongly "done"); a stale state is eventually converged by the fallback path.

## Privacy and telemetry

The browser half **inherits upstream's anonymous install heartbeat**: at most once per UTC day it
POSTs the **package name** (and version when known) to an endpoint run by the upstream project.
The payload carries a random visitor id created in localStorage (the server stores a salted hash of
it, never IP addresses, and exposes aggregate counts only). It contains **no conversation content,
no file paths and no account data**.

Two honest notes:

1. This fork inherited the logic and exposes **no switch** for it. Disabling it entirely means
   removing the call in `src/client/index.ts` (or replacing that module at build time).
2. After forking, the reported package name was left unchanged, so those heartbeats count as the
   upstream package in upstream statistics. Whether to switch the identifier to this fork is an open
   release decision.

## Related components

Sibling components in the same ecosystem — separate repositories, separate versions, separate licenses. All of them link back to the same documentation repository,
[`ops-handoff-design`](https://github.com/kira905/ops-handoff-design)
(Gitee mirror: <https://gitee.com/kira905/ops-handoff-design>):

| Repository | What it does | How it relates to this one |
|---|---|---|
| `dsh-task-board-local` | Self-maintained task board (a card = a real session + a human acceptance gate) | **this repo** |
| [`dsh-session-title-live`](https://github.com/kira905/dsh-session-title-live) | Live session titles with running/done state prefixes | **This board's readability depends on it**: where a card got to — and whether it closed — is read off the executed session's title. If titles cannot be trusted, progress on the board is just a sentence. |
| [`dsh-ecosystem-panel`](https://github.com/kira905/dsh-ecosystem-panel) | Read-only ecosystem health panel (six checks in one view) | **This repo is a typical subject of it** (self-built, registered through an `insert` patch): "did the plugin actually load" is exactly the class of silent failure it answers. |
| [`dsh-diagnostic-tools`](https://github.com/kira905/dsh-diagnostic-tools) | Dependency-closure / decoupling checks + chat image attachment reconciliation | Run it before and after a host upgrade; this repo's compatibility layer (`src/settings-compat.ts`) is the runtime defence against the same class of breakage. |
| [`dsh-butler-archive`](https://github.com/kira905/dsh-butler-archive) | Session archiving (list / preview / restore / delete, optional auto-archive) | Cards produce sessions in bulk; that component moves idle ones out of the session directory so startup and load cost does not grow linearly with card count. |
| [`dsh-firstaid`](https://github.com/kira905/dsh-firstaid) | Zero-dependency incident toolkit (four on-site scenarios behind one entry point) | The fallback: this board depends on a resident host — **if the host wedges, the board is just a spinning page**. Run that one first, then decide whether to act. |

> There are **no code dependencies** between these components and they share no runtime. They point at each other because they answer the same class of question for the same kind of person (running an agent on your own machine for months: install it, find it, see it, diagnose it). Installing one does not affect the others.

## Host compatibility (measured)

| Host package `0.2.0-rc.2` | Half | Status (measured 2026-10-16) |
|---|---|---|
|  | **Host half** (plugin side) | 🟢 **Loads** — no `failed to import` in the startup log; the board API `GET /api/task-board/state` returns `HTTP 200` |
|  | **Browser half** (UI) | 🟢 **Usable** — the entry activates (no longer pending) and all six board columns mount (Backlog / To Do / In Progress / Review / Done / Failed) |
|  | **Settings page** | 🟢 **Usable** — a "Task Board" tab appears under Settings → Built-in plugins, and its card renders (copy follows the UI language) |

How it was measured: installed and exercised for real on an **isolated instance** (separate data root +
port 3090, host `0.2.0-rc.2`) — `npm run build`, copy the artifacts into that instance's profile, restart
it, then open that instance in a real browser and walk the surfaces. The three stages read:

```
# 1.1.2 (host-side startup log)
ui-task-board-local (dsh-task-board-local): failed to import

# the intermediate 1.1.3 candidate (browser-side boot notice)
web boot: 1 entry did not activate dsh-task-board-local: pending (waiting for service: settingsScope)

# this version (browser side): no boot notice; six columns mounted; the plugin's own settings tab appears
```

Two break points — **both fixed in this version** — and one that is **knowingly left open**:

1. **The host half was missing a runtime dependency file — fixed.** `lib/index.js` imports
   `import { SVC, isTurnEnd } from "../lib/host-adapter.js";`, and earlier versions shipped neither that file
   nor the step that generates it (`lib/` is excluded by `.gitignore`; `npm run build` only emits
   `index.js` / `invariant.js` / `client.js`). This version adds the file and its type declaration: both are
   generated for this package's target by the shared host-adaptation generator, and **the header carries the
   `sourceSha256`** of that layer's single source, so the origin can be checked byte for byte.
2. **The browser half declared a 0.1.x settings service — fixed.** `src/client/index.ts` listed
   `settingsScope` in its `inject`, while `0.2.0-rc.2` exposes `ctx.configForms` on the browser side (the
   string `settingsScope` has zero matches inside that host package). **Statically injecting a service that
   does not exist parks the entry at `pending` forever**, which is why the board UI never came up. This
   version reaches the settings face through a **dynamic injection**: `ctx.inject(['configForms'], …)` runs
   only where the service exists, and the pre-0.2.0 line still gets `settingsScope` ⇒ the entry activates
   without any settings service, and a host that serves none degrades to "no settings card" instead of
   "no GUI". The card's seat follows the same generation split: `settings.plugins.tab` on 0.2.0,
   `web-ui.plugin.item` on the older line — one registration per seat, and `slots.inject` only fires for a
   seat the host actually declares.

**Knowingly left open (registered as-is):** the "Agent preset" dropdown in the New Task dialog is empty on
`0.2.0-rc.2`. This repository reads the older line's `connection.api.agentPresets`, while that line hangs the
preset roster off its own remote namespace. The failed read is caught and logged to the console
(`[dsh-task-board] agent preset roster read failed`); **creating cards, the board itself, and settlement are
unaffected** (an empty preset simply means the host default). Fixing it means probing the namespace through
an injection, and belongs to a later version.

⚠️ **This repository does not widen `peerDependencies` to paper over that result** — declaring a range
that happens to pass would only hide the facts above. It declares `react` only, and **adds no
`@deepseek-ai/dsh` peer declaration**.

## Published copy vs. the production tree

This repository is the **generalized public distribution**: it **differs** from the internal tree the author
maintains (internal dependencies and internal naming have been stripped). Concretely, `lib/host-adapter.js`
(the host-side shared adapter's companion artifact) is generated for this package's target, and its **header
keeps the provenance fingerprint** (`sourceSha256`, pointing at the single source it was generated from, which
can be checked byte for byte), while the **body's internal wording and internal component names have been
neutralized** (the internal names for "user / assistant / maintenance component" are replaced with neutral
terms; internal planning-document paths and the developer machine's code name are removed).
⇒ **This copy is deliberately no longer byte-identical to the internal single source — that is intended, not a
defect**; provenance is still verifiable through the header fingerprint. Other artifacts produced by the same
generator are unaffected.

## License

**Apache-2.0** — see [`LICENSE`](./LICENSE), which is **byte-identical** to the license file shipped
inside the upstream package.

This repository is a derivative work of upstream `@linxin666/dsh-client-ui-task-board` 0.3.4. Per
Apache-2.0 §4 it keeps the upstream attribution and a copy of the license, and states the changes in
[`NOTICE`](./NOTICE). The upstream package ships no NOTICE file and its source files carry no
copyright header, so this NOTICE serves as both the attribution notice and the modification notice.
No upstream file is re-licensed: files taken from upstream remain under Apache-2.0.

## Development and self-checks

```bash
npm run build       # tsdown: lib/index.js (host half) + lib/client.js (browser half)
npm run typecheck   # tsc --noEmit
```

Tests live in `_test/` (plain Node scripts, no extra framework; `--experimental-transform-types`
handles the TypeScript sources):

```bash
node --experimental-strip-types --experimental-transform-types _test/<name>.test.mjs
```

**Pre-publish sanitization scan** (read-only, re-runnable, shipped with this repository):

```bash
node scan-oss-sanitize.mjs --dir <dir-to-publish> --deny-file <local-word-list>
```

- The rule table contains **no machine path, host name, account or private component name**; words of
  that kind are injected from outside (`--deny-words` / `--deny-file` / `$OSS_DENY_WORDS`). Because the
  rule table itself is publishable, the scanner **can scan itself** (it skips its own file — see the
  note at the top of the script).
- Judgement model: hit → per-hit judgement → "allowed (with a reason)" or "needs review". **Needs
  review must be 0 before publishing**; with an empty word list the script refuses to report success
  (exit code 3).
- Reports mask the matched text by default, so a report can be committed.
