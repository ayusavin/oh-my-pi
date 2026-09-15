# omp transcript: what a developer sees while an agent works

This is `oh-my-pi`'s own roadmap against the ten CLI-agnostic transcript requirements below. They
were first written in the `harness` project (a rails-for-coding-agents repo) as `spec/ui/transcript.md`;
that repo now keeps only the requirements themselves, their evidence, and the status table for each
CLI target whose install artifacts still live there (Claude Code, as of 2026-09-12). omp's own table —
this file — moved here because this is where the patches that close any of these gaps actually live: as
commits on this repository's own `main`, with upstream release tags merged in as they land. There is no
separate local-clone-and-rebase build anymore; a patch lands directly on `main` the same way any other
change here does.

"The harness" in these ten requirements means whatever installs or patches this CLI. For omp, that is
this repository.

Gathered 2026-09-06/07 from a developer's own reading of live runs; carried forward and corrected
2026-09-12 against omp 18.1.18.

## Requirements

**1. WHEN the agent makes a tool call, the transcript SHALL show one collapsed line saying what the
call is for in the project's own language, expandable on demand to the underlying call.**
Rationale: the reader follows the work, not the shell syntax, and a per-call intent string is already
computed before the call runs — the label costs nothing new.

**2. WHEN a tool call returns, the transcript SHALL show one collapsed result line — outcome (ok, or
failure with its first line), a size count (lines or bytes), and a duration where the call has one —
and SHALL NOT print the full output by default.**
Rationale: output printed in full is the largest single source of scroll and buries the one thing the
reader is looking for, which is whether the call worked.

**3. WHEN the agent states its intent for a run of calls, the transcript SHALL keep that one short
sentence ahead of the run, unchanged.**
Rationale: the narration is the part already worth reading; density work must not eat it.

**4. WHEN one turn contains several tool calls, the transcript SHALL show them as one group with a
count, not as N separate blocks.**
Rationale: the turn is the unit a reader scans by, and per-call blocks erase the turn boundary.

**5. WHEN a message arrives as a stream of deltas, the transcript SHALL show it once; WHEN the same
note is produced twice within one turn, the transcript SHALL show it once.**
Rationale: repeated text makes a short turn look long and costs a re-read before the reader sees it is
the same text.

**6. WHERE a second model comments on a run, the transcript SHALL show only a blocking note by
default, WHILE that model keeps running and its notes keep reaching the agent.**
Rationale: an advisory note is addressed to the agent, not the reader; hiding the display must not
disable the mechanism behind it.

**7. WHEN a call's output exceeds the display budget, the transcript SHALL write it to an artifact and
show a reference, rather than inline it.**
Rationale: output too long to read in place is still worth keeping, and a reference is re-readable on
demand.

**8. WHERE transcript density is adjustable, the harness SHALL expose it as a setting whose default
reproduces the CLI's own out-of-the-box rendering, and an install SHALL NOT change how a CLI looks
unless the developer sets that key.**
Rationale: a shared install that silently changes the terminal reads as a broken CLI, and the
developer has no way to tell which.

**9. WHEN anything is shown in the transcript, it SHALL NOT enter the model's context by virtue of
having been shown.**
Rationale: display and context are separate budgets; conflating them turns a cosmetic preference into
a token cost and a behaviour change.

**10. WHERE a requirement above is not reachable through the CLI's own settings or its documented
extension surface, it SHALL be recorded as a gap and fixed upstream; the harness SHALL NOT reimplement
or shadow a CLI's own renderer.**
Rationale: the shadowing extension that drew its own call and result lines changed how ordinary writes
read on screen and was removed for it (`harness` decision D-019).

## Status

`holds` — true today. `gap` — the seam does not exist yet; it is named. `settings` — reachable by
setting the named key. `partial` — true for part of the requirement, with the missing part named.
`n/a` — the requirement's subject does not exist here. `unassessed` — not yet checked, with what would
check it named.

omp, checked 2026-09-12 against 18.1.18 from a source read plus the 2026-09-07 read against 18.1.10;
never from memory of how the CLI behaves. Four hold, four are reachable by a setting, one is a gap, one
is partial (row 9, corrected from a flat gap):

| # | Requirement | Status | What would close it |
|---|---|---|---|
| 1 | Collapsed intent line per call | settings | `display.toolCalls` = `compact` or `grouped` draws one line per call carrying the call's own intent, derived from the `i` argument, then `tool.intent(args)`, then a label plus inline args (`modes/components/tool-call-compact.ts`). `full`, the default, is the stock card. |
| 2 | Collapsed one-line result | settings | The same two modes render the outcome, the result size in bytes and the call's duration on that one line, and never inline the full output. The remaining piece is the stock card's own preview length, still a terminal-height-scaled constant with no key behind it (source read, 2026-09-07) — prior art for it is the unmerged `tools.collapsedPreviewLines` patch on `legacy/omp-local-patches`. |
| 3 | Agent narration preserved | holds | On by default: `tools.intentTracing` (`omp read omp://config-usage.md`, verified 2026-09-07 against 18.1.13). |
| 4 | One group and a count per turn | settings | `display.toolCalls` = `grouped` folds consecutive tool calls into one group row with a count, expandable to one row per call, and closes the group as soon as any other entry takes the transcript tail. Consecutive `read` calls keep their own existing grouping. No text counter is written into a message, so row 9 is not paid in context. |
| 5 | No repeated rendering | holds | Upstream de-duplication of advisory notes merged 2026-06-26 (#3523); re-check per release rather than assume it stays. |
| 6 | Advisory notes hidden, the model still running | gap | Advisory cards are drawn by the core ahead of any extension renderer, and an extension sees no seam on them (`modes/utils/ui-helpers.ts` ~250-254, verified 2026-09-12 against 18.1.18). Prior art, same unmerged branch as row 1: `feat(advisor): setting to control how advisor notes are shown`, adding `advisor.display` (enum `all` / `blockers` / `none`, default `all`) — port it onto this repository's own `main`. |
| 7 | Long output spilled to an artifact | settings | Artifact spill threshold, artifact tail lines, output max columns (`omp read omp://config-usage.md`, verified 2026-09-07 against 18.1.13). |
| 8 | Density is a setting, default unchanged | holds | No install writes a display key by default, so a fresh install renders exactly as this CLI does out of the box; keep it so as rows 1, 2, 4 and 6 land — every one of the four prior-art settings above defaults to today's unchanged behaviour. |
| 9 | Display does not feed the model's context | partial (corrected 2026-09-12, was `gap`) | Core itself proves the concept: the usage row is built at render time from `message.usage` and never persisted (`packages/coding-agent/src/modes/components/usage-row.ts`; `chat-transcript-builder.ts` ~254-266) — that content already holds. Still a gap: every extension-visible custom message enters the model context (`session/messages.ts` ~1266-1283), `appendEntry` never renders (`session-manager.ts` ~2465; replay only handles `entry.type === "message"` in `session-context.ts` ~377) — so nothing an extension adds can reuse the core's mechanism. Closing the rest of this needs a display-only entry exposed to the extension surface, not just to core. The prior framing ("no display-only entry exists at all") was too broad; corrected against a direct source read of 18.1.18. |
| 10 | No harness-side renderer | holds | Satisfied by removal in the `harness` project (D-019) — a future patch here that shadows a built-in tool with its own drawing code re-opens it. The discipline now belongs to this repository alone; there is no other harness install to coordinate with. |

## Evidence

- 2026-09-07 — source read of the installed omp package (18.1.10) plus a live run: per-call intent
  strings exist but do not reach the built-in tool card; the collapsed preview scales with terminal
  height from a constant with no setting behind it; an extension renders only its own tools and message
  types, so a built-in card is not restylable.
- 2026-06-26 — upstream de-duplication of advisory notes merged (#3523).
- Open upstream issues asking for these behaviours: #4411, #6022, #7574, #2416.
- 2026-09-10, superseded 2026-09-12 — five unreleased patches existed as commits on the `harness`
  branch of a separate clone at `~/Projects/oh-my-pi` (`origin` still `can1357/oh-my-pi`, nothing ever
  pushed there — not this fork): `advisor.display`, `tools.collapsedPreviewLines`, `display.toolCalls`,
  `display.expandScope` (controls what ctrl+o expands: `session` = today's whole-transcript expand,
  `block` = `alt+k`/`alt+j` select one tool block, ctrl+o expands just that block — not itself a fix for
  any row above, but shipped alongside them), plus one bugfix commit threading the already-computed
  intent onto the collapsed tool-call line. No built binary carried them on the machine that read them,
  and rebasing the `display.toolCalls` commit onto a later upstream tag already conflicted in
  `packages/coding-agent/src/tools/read-renderer.ts`. That clone and its rebase-onto-a-side-branch model
  are retired; the settings above are the concrete prior art to reimplement directly on this repository's
  own `main`, merging upstream release tags in as they land instead of rebasing a long-lived branch.
- 2026-09-12 — source read of omp 18.1.18: a display-only transcript entry does exist in the core — the
  usage row (`packages/coding-agent/src/modes/components/usage-row.ts`; `chat-transcript-builder.ts`
  ~254-266), built at render time from `message.usage`, never persisted. Still true: every
  extension-visible custom message enters the model context (`session/messages.ts` ~1266-1283);
  `appendEntry` never renders (`session-manager.ts` ~2465; `session-context.ts` ~377 only replays
  `entry.type === "message"` on resume); advisor cards are drawn by core ahead of any extension
  renderer (`modes/utils/ui-helpers.ts` ~250-254).
- 2026-09-12 — `display.toolCalls` (`full` | `compact` | `grouped`, default `full`) implemented on this
  repository: one new component (`modes/components/tool-call-compact.ts`) plus a branch at each of the
  four sites that materialize a tool card (two in `modes/controllers/event-controller.ts`, one in
  `modes/utils/ui-helpers.ts`, one in `modes/components/chat-transcript-builder.ts`). 59 changed lines
  outside the new files; the default path constructs exactly what upstream constructs. Proven by
  `test/modes/controllers/event-controller-tool-call-display.test.ts` (12 tests) and by the setting
  reading `full` out of the box and `grouped` after a write through this repository's own CLI.

## Compact rendering contract

Requirements 1, 2 and 4 say a call renders as one collapsed line, a result as one collapsed line, and a
run of calls as one group with a count. They do not say what those lines read like. The first
implementation of `display.toolCalls` satisfied them literally and still failed in use: rows read
`Bash command="timeout 25 ssh -o ConnectTimeout=10 -o BatchMode…" error · 887B · 25.1s`,
`Hub op="wait", ids=[1 items], timeoutMs=180000 ok · 857B · 1m53s` and `2 tool calls ok · 6.4KB · 797ms`
— an argument dump, an internal id and a count that names nothing. This section is the contract those
rows must satisfy, drawn from what Claude Code actually prints (evidence below, gathered 2026-09-12).

**C1. A row is the tool's name and its primary argument, in parentheses.** `Bash(timeout 25 ssh …)`,
not `Bash command="timeout 25 ssh …"`. No `key=value` serialization of the argument object ever reaches
a row. Each tool declares which single argument is primary; a tool with none renders its name alone.

**C2. The prose sentence above the run is where the human explanation lives, not the row.** Claude Code
carries no per-call description field on an ordinary row; its rows echo the argument, and the sentence
that says why comes from the model's own narration above them. omp already produces that sentence
(`tools.intentTracing`), so a row never needs to compete with it, and the compact renderer must not eat
it (requirement 3).

**C3. A row carries no status word and no byte count.** Success is the row's own glyph; a failure shows
its first error line on the result row. Size is counted in whatever unit the tool's own result is
counted in — lines for a read, a write or an edit — never bytes. A duration appears only while the call
is still running, or on a subagent's completion row where the run really took measurable time.

**C4. A result is one indented line under its call**, carrying the outcome and a truncation hint when
there is more (`… +18 lines`), and that hint is the affordance to expand.

**C5. A group row names what happened, never how many calls there were.** `3 shell commands`,
`Read 4 files`, `2 agents finished` — a verb, a count and an object. `2 tool calls` is forbidden by this
contract: it is exactly the row the developer could not read. A group whose calls span more than one
tool names the tools, not the total.

**C6. An internal identifier never stands alone on a row.** A background job, a waiting poll, a
subagent: each renders with the human name of the work it carries, with the internal id available only
in the expanded form. `Background job completed [bash] bg_10` fails this; the same row naming the
command or the job's own label passes.

**C7. A grouped run has one parent row and one target.** With `display.toolCalls: "grouped"`,
consecutive calls render as one parent row, which is the only click and hover target. Clicking that row
expands the group into one full `full`-mode `ToolExecutionComponent` card per call, indented under the
retained summary row; each card shows its arguments and output without duplicating that component's
rendering. Clicking the parent row again collapses the group to its one summary row. The cards are
inert: a click on a card row resolves nothing. The parent is clickable whether or not a call has
settled. Keyboard expansion (`ctrl+o`) still expands cards session-wide; only a click-created expansion
keeps an otherwise final block mutable. Text selection must survive (`tui.mouse` puts native selection
on shift+drag). Hovering marks every physical segment of the wrapped
parent row — a band plus an underline, so the mark reads as a link rather than a selection — and nothing
else. This expanded-group shape (retained parent summary, indented inert full cards, parent-only
click-to-toggle) is this fork's own contract, not sourced from Claude Code: upstream's documentation
confirms click-to-expand only at the single collapsed-row level (evidence below) and does not publish
how it lays out an expanded multi-call group or styles hover, so this fork decided that shape directly
rather than infer it from an undocumented surface.

**C8. Truncation is bounded and never mid-escape.** A primary argument is cut to a fixed budget with a
single ellipsis; the cut must not split an escape sequence or a multi-byte character.

**C9. The affordance is readable without hovering.** The parent row states in its leading column what a
click on it does: `▸` opens the collapsed group and `▾` closes the open group. The cards are indented
beneath the retained summary so nesting reads in a still screenshot, and card rows carry no marker
because they are not targets. Hover marking (C7) is an addition to this, never the only signal: a
static transcript, a screenshot, and a scrollback copy still distinguish a closed parent from an open
parent and show the cards nested beneath it.

**C10. A collapsed group is red only when nothing in it worked.** The summary row carries the status
of the run, not of its worst call: pending while any call is in flight, otherwise successful if any
call succeeded, and failed only when every call failed. A single failure among successes must not
paint the whole run red — the row is the only thing a reader sees while it is collapsed, and the
failure is still on its own line once the group is expanded.

**C11. Clickability must be revocable without a restart.** Mouse reporting takes drag away from the
terminal, so native text selection is only reachable through the terminal's bypass modifier
(shift+drag), which some terminals — Warp among them — do not pass through. A session-scoped
keybinding (`app.mouse.toggle`, default `alt+s`) therefore releases capture and takes it back, and
the release wins over `tui.mouse`. Proof is the pty byte stream: the terminal must see
`\x1b[?1003l\x1b[?1000l` on release and `\x1b[?1000h\x1b[?1003h` on retake.

**C12. Interaction is live-viewport only.** A compact tool-group row committed to normal-buffer history
is inert: it has no hover mark and no click action. Committed scrollback cannot be repainted — Warp in
particular never shows a hover mark there — and the former behaviour of raising a mutable copy at the
live bottom produced a visible duplicate of the group. A committed row therefore stays exactly as
printed; only rows still in the live mutable viewport respond.

Evidence, live pty run 2026-09-15 against the freshly built binary
(`scripts/.pty-parent-toggle-probe.ts`, 150x45): the collapsed parent row was
`▸ • 3 shell commands`; hover painted all 150 columns of that row; the parent click expanded cards
showing `$ echo toggle-command-one` and its `toggle-command-one` output; a click on a card row left
the screen byte-identical and logged
`{"message":"tool row click","row":4,"resolved":false,"acted":false}`; the second parent click
restored the one-line summary; after the group scrolled out of the live viewport, the summary-row count
never grew past one. `scripts/.pty-mouse-toggle-probe.ts` reports 5/5 for C11.

**C13. Observability records interaction transitions.** `logger.debug` emits `tool row click` with
`row`, `resolved`, and `acted` once per click; `tool row toggle` with `calls` and `expanded` once per
toggle; `mouse capture` with `capture` and `suspended` once per capture transition; and the `tool row
interaction` aggregate at most every 30s only when a counter advanced, plus once on teardown. Motion is
counted, never logged per event. Its counters distinguish `the terminal sends no motion` from `no row
resolved`.

### Evidence for this contract

- Row shape and argument echo, Claude Code 2.1.150, full captured session:
  `● Bash(mkdir /users/user1/claude-demo)` / `⎿  Done`; `● Write(count.py)` / `⎿  Wrote 2 lines to count.py`;
  `● Read(my_file)` / `⎿  Read 31 lines (ctrl+o to expand)`; `⏺ Update(assets/js/utils/security.js)` /
  `⎿  Updated … with 9 additions and 9 removals` — https://jhpce.jhu.edu/sw/claude-example/ (read
  2026-09-12). Truncation hint and error form: `⎿  Error: …` plus `… +44 lines (ctrl+r to see all)` —
  https://github.com/anthropics/claude-code/issues/8214 (2025-09-26).
- Only the subagent row carries a prose description (`Task(Analyze security warnings)` /
  `⎿  Done (10 tool uses · 37.1k tokens · 1m 33.7s)`), and only it carries counts and a duration — same
  captured session.
- No documented per-call description on a Bash row: `tools-reference` documents `timeout` and
  `run_in_background` only (https://code.claude.com/docs/en/tools-reference, read 2026-09-12), and the
  changelog entry that improved "the Bash tool's description guidance so Claude describes what a command
  does in plain words instead of echoing the command" is about the model's prose, not a row field
  (https://code.claude.com/docs/en/changelog). The narration requirement itself — "Before your first
  tool call, state in one sentence what you're about to do" — is quoted from the system prompt in
  https://github.com/anthropics/claude-code/issues/53239 (2026-04-25), whose whole complaint is that the
  collapsed renderer dropped that sentence and left only `Ran 1 shell command`. That is the failure C2
  exists to prevent.
- Group rows name the work: `Read 1 file (ctrl+o to expand)`, `● Ran 3 stop hooks`,
  `● 2 Explore agents finished (ctrl+o to expand)` with a `├─`/`└─` tree of named agents, and a
  per-turn compound summary of the form "Edited 5 files +27 -23, … searched for 2 patterns, read 3
  files, ran 12 bash commands" — https://code.claude.com/docs/en/interactive-mode and
  https://github.com/anthropics/claude-code/issues/37123 (read 2026-09-12). Sources disagree on the MCP
  form (`Called slack 3 times` in current docs versus `Queried {server} (ctrl+o to expand)` in the
  v2.1.81 changelog); both name the server, neither names a call count alone.
- Per-tool gerund labels exist in the shipped binary (Claude Code 2.1.258, Homebrew cask
  `/opt/homebrew/Caskroom/claude-code@latest/2.1.258/claude`, read 2026-09-12): `getActivityDescription`
  produces `Fetching <host>`, `Editing <path>`, `Writing <path>`, `Searching for <spec>`,
  `Finding <spec>`, and for a subagent the model's own `description` normalized, else `Running task`.
  The same binary carries the group-cap rows `[+N more tool calls]` (cap 6) and
  `[N earlier steps omitted]`, a mobile row contract that "truncates around 30 characters", an output
  preview of the last 10 lines at `columns - 6`, and the classic-TUI help line
  "Click to expand collapsed tool results" — the direct precedent for C7. The Bash row's own template
  and any `ctrl+o`/`ctrl+r` keybinding strings sit in compressed regions of that binary and were not
  recoverable, so C1's Bash form rests on the captured sessions above, not on the bundle.
- **2026-09-13, this fork's own decision, not Claude Code evidence** — this fork originally chose the
  two-level expanded-group layout (retained summary, dimmed per-call lines) and per-call
  click-to-open-a-full-card interaction directly for this repository. That layout decision is
  superseded by the 2026-09-15 rework in C7: the retained parent summary is the only target, and
  expansion shows indented inert full cards, one per call. Upstream evidence only reaches "a row with
  more to show is clickable" (the classic-TUI help line above) and never documents the expanded group's
  internal layout or a hover style, so this fork's decision fills a gap upstream leaves undocumented.
- **2026-09-14, this fork's own local proof, not Claude Code evidence** — the original `--resume`
  proof reported that a compact tool-group row in normal-buffer history was targetable while physically
  visible and that a click raised a mutable copy at the live transcript bottom. That proof is
  superseded by the 2026-09-15 inert-history decision in C12: committed rows remain exactly as printed
  and are not interactive.

## Build notes, from the retired `tools/omp-local/` build

The `harness` project once kept a separate local build of omp carrying these same patches, rebased onto
each new upstream release tag and swapped in as the live aliased `omp` binary on one developer's
machine. That tool and its rebase-onto-a-side-branch model are retired (`harness` decision D-030,
2026-09-12) — patches now land directly on this repository's own `main`. Two facts from it are worth
keeping for whoever wires this repository's own build or release tooling:

- The native addon's exported symbol is version-suffixed (`__piNativesV18_1_15`, etc.), so carrying an
  addon built for a previous release forward is not ABI-compatible — it silently ships a binary whose
  native calls (ast-grep, PTY, clipboard, ...) fail at runtime with no build-time signal. Always fetch
  the matching `@oh-my-pi/pi-natives-<platform>` version for the release being built.
- The live binary must never be replaced until every check has passed: type-check, lint, the patches'
  own tests, a fresh build reporting the correct version string, and a `config get` round-trip
  succeeding for every setting the release is expected to carry. A lost patch should fail a `config get`
  at verification time, not surface later as a missing feature.
