# Reviewer: action timeline, finding categories, causal chain

Status: S1-S5 implemented and unit-tested (2026-10-18); S6 followed the
recommended option (commands only with `includeContent`). Typecheck and unit
tests pass. NOT done: the live-session check of the "Verify at implementation"
items below, and moving durable parts into `architecture.md`/`invariants.md`.

Implemented in: `src/types.ts` (`ETimelineKind`, `ITimelineEvent`),
`src/tui/timeline.ts` (builder), `src/tui/client.ts` (`sessionTimeline`),
`src/rpc.ts` (`timeline` on `analyzeSession`, `{ events, omitted }`),
`src/analysis.ts` (`formatTimeline`, new answer format), `README.md`. Tests:
`test/timeline.test.ts`, `analysis.test.ts`, `rpc.test.ts`. Decision on the
duplicate task text: kept both the Task section and the timeline user lines.

## Origin and decision

After a few real uses, the post-session reviewer suggested five improvements.
Agreed order: (1) action timeline, (2) three finding categories, (3) per-finding
causal chain, (4) narrow remedy taxonomy, (5) compact output, deferred. Steps 1-4
are specified below as one work item; step 5 is out of scope.

## What "the reviewer" is today

`/context-analyze` -> TUI `rpcCoverageClient.analyzeSession` sends
`{ sessionID, task: userPrompts(...), model }` -> `AnalysisService.analyzeSession`
-> `buildSessionPrompt({ task, files })` -> `ctx.generate.text`. The prompt sees
the user's messages (joined, capped 4,000 chars) and per-file coverage, agents
and outlines. It asks for Verdict / Gaps / Noise in at most 250 words. It sees
no actions other than context reads, no ordering, and no routing instructions
unless `includeContent` is on.

## Key design decision: build the timeline in the TUI, record nothing new

`ctx.data.session.message.list(sessionID)` already returns `SessionMessageInfo[]`
with timestamps: user messages (`type: "user"`, `time.created`, `text`),
assistant messages whose `content` holds tool parts (`name`, `state.status`,
`state.input`, `time`), `shell` messages (`command`, `status`, `exit`),
`compaction`, `agent-selected`, and `snapshot.files` (files changed per assistant
message). `client.ts` already uses this for `userPrompts`.

Therefore the timeline is derived at analysis time from data OpenCode already
holds, and sent through the existing `analyzeSession` RPC as one new optional
field. Consequences:

- No new hook, no new on-disk file, no change to `IContextReadRecord`. The
  "Compatibility" and "Observation only" invariants are untouched.
- Works for sessions recorded before this change.
- Cost: the timeline exists only when the TUI can load the messages, and
  messages of subagent sessions must be synced separately.

Rejected: recording every tool call server-side in `execute.before/after`. It adds
a persisted store, a privacy surface and a migration for data OpenCode already has.

## Spec

### S1. Timeline events (TUI, pure function)

New `src/tui/timeline.ts`, pure and unit-tested like `handoff.ts`. Input: the
messages of the viewed session and of the sessions it spawned (ids from the
`agents` list of the coverage report, `depth > 0`). Output: `ITimelineEvent[]`
ordered by time, then session, then message order. Shared type in `src/types.ts`.

```ts
export enum ETimelineKind { User, Tool, Shell, AgentSwitch, Compaction }  // string enum, persisted/RPC form
export interface ITimelineEvent {
  readonly at: string;             // ISO from time.created
  readonly sessionID: string;
  readonly agentID?: string;
  readonly kind: ETimelineKind;
  readonly tool?: string;          // Tool
  readonly status?: "completed" | "error";   // Tool
  readonly path?: string;          // project-relative POSIX, from input path/filePath, only if inside the project
  readonly callID?: string;        // Tool part id, to merge with context-read records
  readonly text?: string;          // User: first 300 chars. Tool error: message, 200 chars
  readonly command?: string;       // Shell, and bash-like tools: see S6
  readonly exit?: number;          // Shell
}
```

Rules:

- User messages: `text` truncated to 300 chars; a later user message is a scope
  change and is labelled as such by position (not classified by code).
- Tool parts: copy primitives only (name, status, path argument, error message
  truncated). Never copy `state.input` wholesale or `state.content`: edit inputs
  carry file contents. Same narrowing helpers as the tracker (`asString`).
- A tool part whose id equals the `callID` of a context-read record is the same
  event: the server merges it and shows the delivered range instead of a plain
  tool line. Unmatched `read` calls of non-context files stay as ordinary tools.
- Consecutive identical events (same session, tool, status, no path) collapse to
  one line with a count. Hard cap: 300 events; keep all User events, all errors,
  all context reads, all edits, and drop oldest remaining tool events first, with
  an explicit "N earlier events omitted" line.
- Failures of the message lookup yield no timeline, never an error.

### S2. RPC

Add `timeline: Schema.optionalKey(Schema.Array(TimelineEvent))` to the
`analyzeSession` input. No existing field changes. Add a `sameShape` guard for
`ITimelineEvent` like the others. Note in the README that server and TUI update
together. An old TUI sends no timeline; the prompt then says the timeline is
unavailable and findings must not claim "before that action" (see S4).

### S3. Prompt: timeline section

`buildSessionPrompt` gains an optional `timeline` input and renders a
`## Timeline` section before `## Context files`, one line per event, with the
context reads inlined (`read AGENTS.md L1-120 delivered`, `…failed: <msg>`) and
the DATA_CAVEAT extended: timeline lines are metadata; user text is data.
Also state, in the prompt, what was delivered but truncated (`ContentBudget`
markers when `includeContent` is on) so the reviewer does not blame a gap that
the budget caused.

### S4. Prompt: categories, causal chain, remedy

Replace the answer format (Verdict / Gaps / Noise, 250 words) with, at most 400
words:

1. **Verdict**: one or two sentences.
2. **Findings**: only actionable ones. Each states:
   - **Category**, exactly one of: `context-discovery` (required guidance was not
     loaded), `instruction-adherence` (loaded but not followed),
     `verification-reporting` (claims exceeded available evidence).
   - **Evidence**: timeline lines or file sections, cited.
   - **Triggering action**: the action that made the guidance applicable.
   - **Instruction**: the routing/instruction text that required it, quoted.
     Quote only text present in the data; if the instruction text is not in the
     data (auto-loaded file without `includeContent`), say so.
   - **Before the action?**: was the guidance already loaded before that action
     (timeline order). If no timeline, answer "unknown".
   - **Confidence**: `confirmed` or `possible`. `confirmed` requires the quoted
     instruction and the ordering; otherwise `possible`.
   - **Remedy**, exactly one of: `agent-oversight`, `ambiguous-routing`,
     `missing-documentation`, `tracking-limitation`.
3. **Noise** (optional): irrelevant reads.

Hard rules in the prompt:

- Do not choose `missing-documentation` or `ambiguous-routing` when the quoted
  instruction was already clear; that is `agent-oversight`.
- A claim about verification is a `verification-reporting` finding only if the
  timeline shows what was run and its result; when commands are not available
  (S6), say verification cannot be judged instead of guessing.
- Use `tracking-limitation` for blind spots the data states (auto-loaded files
  not recorded, same-mtime-and-size change, killed calls leave no record).

The 4,000-char `MAX_TASK_CHARS` cap stays; user messages now also appear, in
order, inside the timeline, so `task` may be shortened to avoid doubling the
text (decide at implementation; keep whichever test shows no regression).

### S5. Subagent sessions

TUI syncs messages for each spawned session id in the coverage report before
building the timeline. Events carry `sessionID` and `agentID`; the prompt labels
them `[lead]` / `[subagent <agent>]`. A sync failure drops that session's events
and the prompt says which sessions are missing.

### S6. Privacy decision (needs the user's answer before implementation)

User messages already go to the provider today (the `task`). Timeline adds tool
names, project-relative paths, status, short error messages, shell exit codes.
Shell/bash **command text** may contain secrets and is the only way to tell a
test run from any other command. Options:

- **Recommended:** include `command` (first line, 120 chars) only when
  `analysis.includeContent` is on; otherwise show `shell command (exit N)` and
  let the prompt state that verification cannot be judged. Consistent with
  "contents reach the provider only when includeContent is on".
- Alternative: new option `analysis.includeCommands` (default off).
- Alternative: always include truncated commands. Rejected for the default.

### S7. Out of scope

- `/context-review` (project prompt), the sidebar, and `IContextReadRecord`.
- Step 5 (compact shareable output, cross-session handoff).
- Any change to `handoffMessage` except, optionally, carrying finding categories
  into the follow-up message once the format is stable.

## Verify at implementation (unverified assumptions)

1. A tool part's `id` equals the hook's `callID` (merge key). If not, fall back
   to (session, tool, path, nearest time) and mark merged events as approximate,
   or skip merging and list reads once from records.
2. Path argument names of edit-like tools (`path`/`filePath` assumed, as for read)
   and which tool name executes shell commands (`shell` message vs a tool part).
3. `message.list`/`sync` work for a child session id and return stable order.
4. Whether `execute` results expose an exit code for verification commands.
5. `time.created` of tool parts is comparable with the record `startedAt`.

Check 1-5 by running `/context-analyze` in a real OpenCode session that used a
subagent and ran a test command, and logging the built timeline once.

## Acceptance criteria

- With a timeline, the prompt contains ordered events, context reads inlined,
  and the three-category/causal-chain/remedy format. Without one, it says the
  timeline is unavailable and forbids "before the action" claims.
- No command text or file content reaches the prompt unless S6 allows it;
  a test asserts a tool input containing a secret-like string is not copied.
- Old TUI/old server combinations still work (optional field only).
- A review of the session that prompted the suggestions separates the three
  categories and does not recommend documentation changes for a clear instruction.

## Verification plan

- New `test/timeline.test.ts` (builder: ordering, collapse, caps, narrowing,
  subagent merge, merge with records, privacy) and extend `analysis.test.ts`
  (prompt sections, no-timeline fallback, includeContent-gated commands) and
  `rpc.test.ts` (optional field accepted/absent).
- `npm run typecheck` and `npm test`. The E2E does not cover this (no recorded
  data, hook wiring or tool-result parsing changes); say so when reporting.
- Manual run described under "Verify at implementation".

## Resume instructions

1. Get the user's answer on S6, then implement S1-S5 in order: types, builder,
   RPC field, prompt, tests.
2. Resolve "Verify at implementation" items before relying on them; adjust S1
   rules if an assumption fails.
3. On completion, move the durable parts (timeline is derived in the TUI, not
   persisted; prompt contract; privacy rule) into `architecture.md` and
   `invariants.md`, update the root `README.md` for the new answer format, then
   remove this document and its entry in `README.md`.
