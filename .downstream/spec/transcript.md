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
