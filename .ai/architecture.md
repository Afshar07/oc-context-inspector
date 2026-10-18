# Architecture

User-facing behavior (record format, glyphs, options, commands) is documented in the root `README.md`; do not restate it here. This file maps the code.

## Two halves, one RPC

| Half | Entry | Code | Role |
| --- | --- | --- | --- |
| Server | `index.ts` -> `src/index.ts` | `src/*.ts` | Hooks tool/session events, writes data, serves RPC `context-inspector`, runs model analysis |
| Terminal UI | `tui.ts` -> `src/tui/index.tsx` | `src/tui/*` | Sidebar, preview panel, analysis panel, slash commands; talks to the server only through the RPC |

Both halves share `id: "opencode-context-inspector"` and `src/types.ts`. Update them together: RPC payloads gain fields over time.

## Server modules (`src/`)

| File | Responsibility |
| --- | --- |
| `index.ts` | `Plugin.define` setup, `resolveOptions`, RPC registration, hook wiring. Public re-exports |
| `matcher.ts` | `ContextPathMatcher`: classifies a path as context (globs relative to project; no-`/` pattern = basename at any depth; `dir/**` includes `dir`) |
| `tracker.ts` | `ContextReadTracker`: pairs `execute.before`/`execute.after` per (session, call id), emits one `IContextReadRecord` per explicit context read |
| `delivery.ts` | `parseDelivery`: lines the tool actually returned, from the `Read file X, lines A-B` header or paged result |
| `store.ts` | JSONL append/read, session markers, `tracking.json`. Session IDs are sanitized into file names |
| `sessions.ts` | `SessionObserver` (marks a session observed once, resolves parent), `SessionRegistry` (lists sessions, ancestors, tracking start) |
| `coverage.ts` | `CoverageService`: per-file status, merged ranges, certainty, changed/deleted detection, per-agent repeat/handoff accounting, file preview |
| `analysis.ts` | `AnalysisService`: builds the session and project prompts (session prompt includes the timeline: `formatTimeline`, `readKey`), `aggregateUsage`, outlines/sections, `ContentBudget`. Calls an injected `Generate` |
| `rpc.ts` | `ContextInspectorRpc` schema (`coverage`, `preview`, `analyzeSession` with optional `timeline`, `reviewProject`, `read` event) |
| `evaluation/*` | Context revisions and experiments (see below). Own types (`evaluation/types.ts`), own store, own RPC schemas (`rpc-schema.ts`, merged into `rpc.ts`) |
| `model-ref.ts` | `provider/model[#variant]` parse and format |
| `types.ts` | All shared types. `E*` enums, `I*` interfaces |

## TUI modules (`src/tui/`)

`timeline.ts` and `descendants.ts` build the reviewer timeline (below). `index.tsx` registers slots (`sidebar.content`, `session.panel`, `app`) and keymap layers (commands plus browse mode). `client.ts` wraps the RPC, the follow-up-session creation and the timeline loading (`sessionTimeline`). `source.ts` is the data hook/resource layer. `format.ts`, `markdown-parse.ts` and `handoff.ts` are pure logic (unit-tested); `Sidebar`, `Preview`, `Analysis`, `AnswerMarkdown` are Solid components.

## Data flow

1. `session.hook("context")` and `tool.hook("execute.before")` call `SessionObserver.observe`, which writes `sessions/<id>.json` once and asks `ctx.session.get` for the parent.
2. `execute.before` stats the file (fingerprint) and stores pending state keyed by session then call id.
3. `execute.after` builds the record (delivered range, fingerprint, lineage) and appends it to `<dataDir>/<sessionID>.jsonl`, then emits a `read` event (with `ancestors`) so lead-session sidebars refresh when a subagent reads.
4. The TUI calls `coverage`/`preview`/`analyzeSession`/`reviewProject`; the server computes from the JSONL and the live file system on demand. Nothing derived is persisted.

## Reviewer timeline (`/context-analyze`)

- **Derived in the TUI, never recorded.** `client.ts` `sessionTimeline` reads OpenCode's own message log (`ctx.data.session.message`) and sends the result as the optional `timeline` field of the `analyzeSession` RPC (`events`, `omitted`, `sessions`). No hook, no on-disk file, no change to `IContextReadRecord`; old sessions work.
- **Subagents come from OpenCode's session listing, not from context reads.** `descendants.ts` `discoverSessions` walks `ctx.client.session.list({ parentID })` breadth-first (all pages, nested delegation, each session once, bounded by `MAX_DESCENDANT_SESSIONS`/`DEPTH`), then adds sessions the coverage report names that the listing missed. So subagents that only edit, run tests or answer still appear. A session whose messages fail to sync stays in `sessions` as `unavailable` with a reason; the prompt says its steps are missing.
- **Reads join the timeline by `(sessionID, callID)`.** Call ids are unique only within a session, so `analysis.ts` keys records with `readKey`, taken from the record file's session. A step without a call id, or with no record, stays a plain tool line.
- **Prompt contract** (`buildSessionPrompt` in `analysis.ts`): ordered timeline with reads inlined, then findings with one category (`context-discovery`, `instruction-adherence`, `verification-reporting`), evidence, triggering action, quoted instruction, before-the-action, confidence (`confirmed` needs the quote and the ordering) and one remedy (`agent-oversight`, `ambiguous-routing`, `missing-documentation`, `tracking-limitation`). A clear instruction is never a documentation remedy. Without a timeline the prompt says ordering is unknown. The answer ends with a one-line summary of what reached the model.
- Event caps (300, essential events kept) live in `timeline.ts`; the follow-up handoff is unchanged by the timeline.

## Context revisions and experiments (`src/evaluation/`)

Measurement infrastructure: it records which version of the context an agent had and compares sessions before and
after a documentation change. It never edits documentation, runs agents or calls a model. Domain rules are in `invariants.md`.

| File | Responsibility |
| --- | --- |
| `types.ts` | `IRevisionSnapshot`, `ISessionRevisionRecord`, `IExperiment`, `IEvaluationResult`, enums. Schema version constant |
| `revisions.ts` | Revision ids (sorted paths + SHA-256), `diffSnapshots` (added/removed/modified/renamed), `RevisionSnapshotter` (cached list, hash cache keyed by mtime+size, single-flight), `classifySessionRevision` |
| `session-revisions.ts` | `SessionRevisionTracker`: per-session queue; start revision from the first `context` request (earlier `prompt` snapshot kept provisional); later requests append changed revisions |
| `groups.ts` | `GroupResolver`: lead sessions, a lead plus its subagents as one unit, the group's revision state |
| `store.ts`, `json-file.ts` | `EvaluationStore` (snapshots, session records, experiments); atomic JSON write and tolerant read |
| `experiments.ts` | `ExperimentService`: create/validate/dedupe, detect and confirm the candidate, session offers and selection, outcome labels, close. Per-experiment lock |
| `metrics.ts` | `measureGroup`: deterministic per-group measurements from read records and activity |
| `comparison.ts` | `compareGroups`, per-metric verdicts, `overallVerdict` (separate `discovery` and effectiveness verdicts), comparability split into confirmed differences and unknown gaps, limitations. Thresholds are `DEFAULT_SETTINGS` |
| `evaluate.ts` | `EvaluationService`: selects clean samples, records exclusions with reasons, builds and stores the result |
| `activity.ts` | `summarizeActivity` (pure; used by the TUI): first file change, shell and test-like run counts from the message log. Returns counts only |
| `rpc-handlers.ts` | Handlers merged into the plugin RPC; user mistakes (`ExperimentError`) come back as `{ ok: false, error }` |

Wiring (`src/index.ts`): `ctx.session.hook("prompt")` and `("context")` feed the tracker (both awaited inside try/catch);
`execute.before` only calls `snapshotter.invalidate()` when a non-read tool targets a context path (a path match, no scan).

TUI: `experiment-client.ts` (RPC adapter; gathers `ISessionActivity` per lead session before `evaluateExperiment`),
`experiment-flow.ts` (dialogs: create from an analysis, manage, candidate confirmation, session selection, labels),
`Evaluation.tsx` + `evaluation-format.ts` (panel and pure formatting). `Analysis.tsx` binds `e`; `index.tsx` registers
`/context-experiments` and `/context-evaluate`.

## On-disk layout (`<project>/.opencode/context-inspector/`, git-ignored)

```
<sessionID>.jsonl        one record per context read
sessions/<sessionID>.json  observation marker, written once
tracking.json            when session tracking began
evaluation/snapshots/<revisionId>.json     paths, SHA-256, sizes of one revision (content-addressed, written once)
evaluation/sessions/<sessionID>.json       revision(s) a session ran under, models, agents
evaluation/experiments/<id>.json           experiment, selected sessions, labels, stored evaluations
```

## Follow-up sessions

`n` in an analysis panel creates a session carrying the review as a **queued** message: a fork of the analyzed session after `/context-analyze`, a fresh session after `/context-review`. Message text comes from `src/tui/handoff.ts`.
